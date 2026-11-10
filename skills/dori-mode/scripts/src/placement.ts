import type { DoriConfig, GuardThresholds, PlacementConfig } from "./config.ts";
import { doneRepos } from "./launch.ts";
import { LaneOpsError, type LaneOps } from "./lane-ops.ts";
import { type SampleResult, UNSUPPORTED_SHELL } from "./remote-guard.ts";
import { canLaunch, type LaunchVerdict } from "./routing.ts";
import type { RunnerRow } from "./runner/hub.ts";
import type { WorkspaceEntry } from "./runner/protocol.ts";

/** The reserved machine name for this host. */
export const LOCAL_MACHINE = "local";

export type PlacementInput = { readonly machine?: string; readonly cwd?: string; readonly done: string; readonly pane?: string; readonly workspace?: string };

export type Placement = {
  /** "local" or a machine label. */
  readonly machine: string;
  /** `runner`: a runner declares the workspace; `workspace`: the deprecated config.placement.workspaces table. */
  readonly source: "flag" | "runner" | "workspace" | "default";
  /** The owner/repo a runner declares, or the `workspaces` key that matched ("*" included). */
  readonly rule?: string;
  /** Only a default placement may move to a fallback machine. */
  readonly movable: boolean;
  /** source runner: the checkout the owning runner declared for the repo. */
  readonly cwd?: string;
  /** source runner: false when the owning runner is not connected, so the launch holds for it. */
  readonly online?: boolean;
};

/** What one runner reported about its repos (hub `workspaces` column) and whether it is connected now. */
export type RunnerPlacement = {
  readonly machine: string;
  readonly online: boolean;
  readonly declared: readonly WorkspaceEntry[];
  readonly detected: readonly WorkspaceEntry[];
};

/** The placement reports of the hub's runner rows; `online` says whether a row's runner is connected. */
export const runnerPlacements = (rows: readonly RunnerRow[], online: (row: RunnerRow) => boolean): RunnerPlacement[] =>
  rows.flatMap((row) => (row.workspaces ? [{ machine: row.label, online: online(row), declared: row.workspaces.declared, detected: row.workspaces.detected }] : []));

/** Two or more runners declare the same repo: the launch is refused until `--machine` picks one. */
export class PlacementConflict extends Error {
  readonly code = "PLACEMENT_CONFLICT";
  constructor(readonly repo: string, readonly machines: readonly string[]) {
    super(`PLACEMENT_CONFLICT ${repo} is declared by runners ${machines.join(", ")}; pass --machine, and keep it in only one runner-config.json workspaces`);
  }
}

/** Runners declare workspaces: the config table is no longer read. */
const declaring = (reports: readonly RunnerPlacement[]): boolean => reports.some((r) => r.declared.length > 0);

export const DEPRECATED_TABLE_READ = "PLACEMENT_CONFIG_DEPRECATED placement.workspaces is read because no runner declares workspaces; declare each repo in its machine's runner-config.json workspaces, then delete the table";
export const DEPRECATED_TABLE_IGNORED = "PLACEMENT_CONFIG_DEPRECATED placement.workspaces is ignored because runners declare workspaces; delete it from the config";

/**
 * The declared owner of a workspace task: the runner whose declared path is the longest prefix of `cwd`, else the
 * runners declaring the first Done repo any runner declares. Throws PlacementConflict when two machines tie.
 */
const declaredOwner = (cwd: string | undefined, repos: readonly string[], reports: readonly RunnerPlacement[]): { report: RunnerPlacement; entry: WorkspaceEntry } | undefined => {
  const all = reports.flatMap((report) => report.declared.map((entry) => ({ report, entry })));
  const pick = (found: typeof all, repo: string) => {
    const machines = [...new Set(found.map((f) => f.report.machine))];
    if (machines.length > 1) throw new PlacementConflict(repo, machines);
    return found[0];
  };
  if (filled(cwd)) {
    const byPath = all.filter(({ entry }) => cwd === entry.path || cwd.startsWith(entry.path.endsWith("/") ? entry.path : `${entry.path}/`));
    const longest = Math.max(-1, ...byPath.map(({ entry }) => entry.path.length));
    const found = byPath.filter(({ entry }) => entry.path.length === longest);
    if (found.length) return pick(found, found[0]!.entry.repo);
  }
  for (const repo of repos) {
    const found = all.filter(({ entry }) => entry.repo.toLowerCase() === repo.toLowerCase());
    if (found.length) return pick(found, found[0]!.entry.repo);
  }
  return undefined;
};

const filled = (s: string | undefined): s is string => typeof s === "string" && s.trim() !== "";

/** The longest absolute-path key equal to `cwd` or a parent of it at a path boundary. */
const pathRule = (cwd: string, keys: readonly string[]): string | undefined =>
  keys
    .filter((key) => key.startsWith("/") && (cwd === key || cwd.startsWith(key.endsWith("/") ? key : `${key}/`)))
    .sort((a, b) => b.length - a.length)[0];

/**
 * --machine wins. Once any runner declares workspaces, a workspace task goes to the runner that declares it (held while
 * that runner is offline, refused with PlacementConflict when two declare it) and an undeclared one to `defaultMachine`.
 * Before that, a workspace task follows the deprecated `placement.workspaces` table (else local). Anything else goes to
 * `defaultMachine`.
 */
export const resolvePlacement = (input: PlacementInput, placement: PlacementConfig, reports: readonly RunnerPlacement[] = []): Placement => {
  if (filled(input.machine)) return { machine: input.machine.trim(), source: "flag", movable: false };
  const repos = doneRepos(input.done);
  const workspaceTask = filled(input.cwd) || filled(input.pane) || filled(input.workspace) || repos.length > 0;
  if (workspaceTask && declaring(reports)) {
    const owner = declaredOwner(input.cwd, repos, reports);
    if (owner) return { machine: owner.report.machine, source: "runner", rule: owner.entry.repo, movable: false, cwd: owner.entry.path, online: owner.report.online };
  } else if (workspaceTask) {
    const keys = Object.keys(placement.workspaces);
    const byLower = new Map(keys.map((key) => [key.toLowerCase(), key]));
    const rule = (filled(input.cwd) ? pathRule(input.cwd, keys) : undefined)
      ?? repos.map((repo) => byLower.get(repo.toLowerCase())).find((key) => key !== undefined)
      ?? (keys.includes("*") ? "*" : undefined);
    return rule === undefined
      ? { machine: LOCAL_MACHINE, source: "workspace", movable: false }
      : { machine: placement.workspaces[rule]!, source: "workspace", rule, movable: false };
  }
  return { machine: placement.defaultMachine, source: "default", movable: true };
};

export type MachineCheck = { readonly machine: string; readonly verdict: LaunchVerdict; readonly summary: string };

/**
 * A remote machine's launch verdict: canLaunch's memory/disk/pane rules; -1 metrics never hold, CPU load never holds.
 * A machine with an unsupported remote shell (UNSUPPORTED_SHELL) has no metrics, so only its pane count holds.
 */
export const machineVerdict = (result: SampleResult, panes: number, t: GuardThresholds, label: string): LaunchVerdict => {
  if (!result.ok && !result.detail.startsWith(UNSUPPORTED_SHELL)) return { ok: false, reasons: [`machine ${label} unreachable: ${result.detail}`] };
  const s = result.ok ? result.sample : { load1: 0, memFreePct: -1, diskFreeGb: -1, swapFreeGb: -1, swapTotalGb: -1 };
  const reasons = [...canLaunch({
    load1: s.load1,
    memFreePct: s.memFreePct === -1 ? Infinity : s.memFreePct,
    diskFreeGb: s.diskFreeGb === -1 ? Infinity : s.diskFreeGb,
    swapFreeGb: s.swapFreeGb,
    swapTotalGb: s.swapTotalGb,
    panes,
  }, t).reasons];
  if (panes < 0) reasons.push("pane count unreadable");
  return { ok: reasons.length === 0, reasons };
};

/** `memory free N%, disk free N GB, panes N`; an unreadable (-1) metric shows as `?`. */
export const summaryOf = (memFreePct: number, diskFreeGb: number, panes: number): string =>
  `memory free ${memFreePct === -1 ? "?" : `${memFreePct}%`}, disk free ${diskFreeGb === -1 ? "?" : `${diskFreeGb.toFixed(0)} GB`}, panes ${panes < 0 ? "?" : panes}`;

/** Why a machine cannot be observed: no connected runner names the install command, anything else is the runner's error. */
const unobservable = (machine: string, error: unknown): string => {
  if (error instanceof LaneOpsError && error.code === "RUNNER_UNAVAILABLE") {
    return machine === LOCAL_MACHINE
      ? "no runner (the supervisor runs the local runner: systemctl --user start dori-supervisor.service)"
      : `no runner (dori runner install --machine ${machine})`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return machine === LOCAL_MACHINE ? `host unobservable: ${detail}` : `machine ${machine} unreachable: ${detail}`;
};

/**
 * Whether `machine` ("local" or a label) has room for one more lane, with a short metrics summary ("" on failure). The
 * machine's runner observes it (`q.machine.observe`: its guard sample and pane list); a machine without a connected runner
 * cannot host a lane, so it holds. A remote machine is judged at the thresholds its runner-config.json sets (the
 * observation's `guard`), config.guard for every key it does not set; the local machine always at config.guard.
 */
export const checkMachine = async (ops: LaneOps, config: DoriConfig, machine: string): Promise<MachineCheck> => {
  let seen;
  try {
    seen = await ops.observeMachine(machine === LOCAL_MACHINE ? undefined : machine);
  } catch (error) {
    return { machine, verdict: { ok: false, reasons: [unobservable(machine, error)] }, summary: "" };
  }
  const s = seen.sample;
  if (machine === LOCAL_MACHINE) return { machine, verdict: canLaunch(s, config.guard), summary: summaryOf(s.memFreePct, s.diskFreeGb, s.panes) };
  const panes = s.panes >= 0 ? seen.panes.length : -1;
  const result: SampleResult = {
    ok: true,
    sample: { os: seen.os, load1: s.load1, memFreePct: s.memFreePct, swapFreeGb: s.swapFreeGb, swapTotalGb: s.swapTotalGb, diskFreeGb: s.diskFreeGb },
  };
  const guard: GuardThresholds = { ...config.guard, ...seen.guard };
  return { machine, verdict: machineVerdict(result, panes, guard, machine), summary: summaryOf(s.memFreePct, s.diskFreeGb, panes) };
};

/** Local keeps the legacy `CAN_LAUNCH` / `HOLD <reasons>`; a remote line names its machine. */
export const verdictLine = (machine: string, v: LaunchVerdict): string => {
  const tag = machine === LOCAL_MACHINE ? "" : ` machine=${machine}`;
  return v.ok ? `CAN_LAUNCH${tag}` : `HOLD${tag} ${v.reasons.join(" | ")}`;
};

export const placementLine = (p: Placement): string =>
  `PLACEMENT machine=${p.machine} source=${p.source}${p.rule === undefined ? "" : ` rule=${p.rule}`}${p.cwd === undefined ? "" : ` cwd=${p.cwd}`}`;

/** The PLACEMENT_CONFIG_DEPRECATED line when a table rule decided `p`, else none. */
export const placementWarnings = (p: Placement): string[] => (p.source === "workspace" && p.rule !== undefined ? [DEPRECATED_TABLE_READ] : []);

/**
 * `dori placement`: one line per declared repo (`WORKSPACE repo=R machine=M path=P runner=online|offline`, or
 * `PLACEMENT_CONFLICT repo=R machines=a,b`), one per repo only detected (`DETECTED ...`, information: it follows
 * defaultMachine), then `DEFAULT machine=D fallback=a,b|-` and a deprecation line when config.placement.workspaces is set.
 */
export const placementTable = (reports: readonly RunnerPlacement[], placement: PlacementConfig): string[] => {
  const lines: string[] = [];
  const declared = new Map<string, { repo: string; at: { machine: string; path: string; online: boolean }[] }>();
  for (const r of reports) for (const e of r.declared) {
    const k = e.repo.toLowerCase();
    const row = declared.get(k) ?? { repo: e.repo, at: [] };
    row.at.push({ machine: r.machine, path: e.path, online: r.online });
    declared.set(k, row);
  }
  for (const { repo, at } of [...declared.values()].sort((a, b) => a.repo.localeCompare(b.repo))) {
    const machines = [...new Set(at.map((a) => a.machine))];
    if (machines.length > 1) lines.push(`PLACEMENT_CONFLICT repo=${repo} machines=${machines.join(",")}`);
    else lines.push(`WORKSPACE repo=${repo} machine=${at[0]!.machine} path=${at[0]!.path} runner=${at[0]!.online ? "online" : "offline"}`);
  }
  const detected = reports.flatMap((r) => r.detected.filter((e) => !declared.has(e.repo.toLowerCase())).map((e) => ({ ...e, machine: r.machine })))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.machine.localeCompare(b.machine));
  for (const d of detected) lines.push(`DETECTED repo=${d.repo} machine=${d.machine} path=${d.path} (no runner declares it)`);
  lines.push(`DEFAULT machine=${placement.defaultMachine} fallback=${placement.fallback.length ? placement.fallback.join(",") : "-"}`);
  if (Object.keys(placement.workspaces).length) lines.push(declaring(reports) ? DEPRECATED_TABLE_IGNORED : DEPRECATED_TABLE_READ);
  return lines;
};

export type LaunchPlan = {
  readonly placement: Placement;
  /** The machine the launch goes to (a fallback with room, else the placed one) and its verdict. */
  readonly check: MachineCheck;
  /** PLACEMENT, then PLACEMENT_FALLBACK when the launch moved. */
  readonly lines: readonly string[];
};

/**
 * Places a launch and checks it there; a movable placement on HOLD takes the first `fallback` machine with room. A
 * launch placed on a declaring runner that is offline holds for it unchecked: it never moves to another machine.
 */
export const planLaunch = async (input: PlacementInput, placement: PlacementConfig, check: (machine: string) => Promise<MachineCheck>, reports: readonly RunnerPlacement[] = []): Promise<LaunchPlan> => {
  const p = resolvePlacement(input, placement, reports);
  const lines = [placementLine(p), ...placementWarnings(p)];
  if (p.online === false) {
    return { placement: p, check: { machine: p.machine, verdict: { ok: false, reasons: [`runner ${p.machine} that owns ${p.rule} is offline; the launch waits for it`] }, summary: "" }, lines };
  }
  const first = await check(p.machine);
  if (first.verdict.ok || !p.movable) return { placement: p, check: first, lines };
  for (const machine of placement.fallback) {
    if (machine === p.machine) continue;
    const next = await check(machine);
    if (next.verdict.ok) return { placement: p, check: next, lines: [...lines, `PLACEMENT_FALLBACK ${p.machine} -> ${machine} (${first.verdict.reasons.join(" | ")})`] };
  }
  return { placement: p, check: first, lines };
};
