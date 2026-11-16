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
  /** `runner`: a runner declares the workspace; `workspace`: a workspace task while no runner declares any (this host). */
  readonly source: "flag" | "runner" | "workspace" | "default";
  /** source runner: the owner/repo the owning runner declares. */
  readonly rule?: string;
  /** Only a default placement may move to a fallback machine. */
  readonly movable: boolean;
  /** source runner: the checkout the owning runner declared for the repo. */
  readonly cwd?: string;
  /** source runner: false when the owning runner (every candidate, when there are several) is not connected, so the launch holds for it. */
  readonly online?: boolean;
  /**
   * source runner, only when two or more runners declare the repo: every declaring runner in candidate order
   * (placement.fallback order, then label); `machine`/`cwd`/`online` above are the preferred one, and planLaunch picks.
   */
  readonly candidates?: readonly PlacementCandidate[];
};

/** One runner declaring the placed repo: its machine, the checkout it declared, and whether it is connected. */
export type PlacementCandidate = { readonly machine: string; readonly cwd: string; readonly online: boolean };

/** What one runner reported about its repos (hub `workspaces` column) and whether it is connected now. */
export type RunnerPlacement = {
  readonly machine: string;
  readonly online: boolean;
  readonly declared: readonly WorkspaceEntry[];
  readonly detected: readonly WorkspaceEntry[];
  /** The runner's lane worktree root, when it reported one. */
  readonly worktreeRoot?: string;
};

/** The placement reports of the hub's runner rows; `online` says whether a row's runner is connected. */
export const runnerPlacements = (rows: readonly RunnerRow[], online: (row: RunnerRow) => boolean): RunnerPlacement[] =>
  rows.flatMap((row) => (row.workspaces ? [{
    machine: row.label, online: online(row), declared: row.workspaces.declared, detected: row.workspaces.detected,
    ...(row.workspaces.worktreeRoot !== undefined ? { worktreeRoot: row.workspaces.worktreeRoot } : {}),
  }] : []));

/** Some runner declares workspaces. */
const declaring = (reports: readonly RunnerPlacement[]): boolean => reports.some((r) => r.declared.length > 0);

/**
 * The declared owners of a workspace task: the runners whose declared path is the longest prefix of `cwd`, else the
 * runners declaring the first Done repo any runner declares; one candidate per machine (its first entry).
 */
const declaredOwners = (cwd: string | undefined, repos: readonly string[], reports: readonly RunnerPlacement[]): { repo: string; candidates: PlacementCandidate[] } | undefined => {
  const all = reports.flatMap((report) => report.declared.map((entry) => ({ report, entry })));
  const owners = (found: typeof all) => ({
    repo: found[0]!.entry.repo,
    candidates: found.filter((f, i) => found.findIndex((g) => g.report.machine === f.report.machine) === i)
      .map(({ report, entry }) => ({ machine: report.machine, cwd: entry.path, online: report.online })),
  });
  if (filled(cwd)) {
    const byPath = all.filter(({ entry }) => cwd === entry.path || cwd.startsWith(entry.path.endsWith("/") ? entry.path : `${entry.path}/`));
    const longest = Math.max(-1, ...byPath.map(({ entry }) => entry.path.length));
    const found = byPath.filter(({ entry }) => entry.path.length === longest);
    if (found.length) return owners(found);
  }
  for (const repo of repos) {
    const found = all.filter(({ entry }) => entry.repo.toLowerCase() === repo.toLowerCase());
    if (found.length) return owners(found);
  }
  return undefined;
};

/** Candidate order: placement.fallback order first, then the remaining machines by label. */
const candidateOrder = (candidates: readonly PlacementCandidate[], placement: PlacementConfig): PlacementCandidate[] => {
  const rank = (machine: string): number => { const i = placement.fallback.indexOf(machine); return i < 0 ? Infinity : i; };
  return [...candidates].sort((a, b) => rank(a.machine) - rank(b.machine) || a.machine.localeCompare(b.machine));
};

/** placement.defaultMachine when it is one of `candidates`, else the first. */
const preferred = <T extends { readonly machine: string }>(candidates: readonly T[], placement: PlacementConfig): T | undefined =>
  candidates.find((c) => c.machine === placement.defaultMachine) ?? candidates[0];

const filled = (s: string | undefined): s is string => typeof s === "string" && s.trim() !== "";

/**
 * --machine wins. Once any runner declares workspaces, a workspace task goes to the runner that declares it (held while
 * that runner is offline) and an undeclared one to `defaultMachine`. When several runners declare it, all are
 * `candidates` and the preferred online one (defaultMachine first, else candidate order) is placed; planLaunch picks.
 * Before that, a workspace task stays on this host. Anything else goes to `defaultMachine`.
 */
export const resolvePlacement = (input: PlacementInput, placement: PlacementConfig, reports: readonly RunnerPlacement[] = []): Placement => {
  if (filled(input.machine)) return { machine: input.machine.trim(), source: "flag", movable: false };
  const repos = doneRepos(input.done);
  const workspaceTask = filled(input.cwd) || filled(input.pane) || filled(input.workspace) || repos.length > 0;
  if (workspaceTask && declaring(reports)) {
    const owners = declaredOwners(input.cwd, repos, reports);
    if (owners) {
      const candidates = candidateOrder(owners.candidates, placement);
      const lead = (preferred(candidates.filter((c) => c.online), placement) ?? preferred(candidates, placement))!;
      return { machine: lead.machine, source: "runner", rule: owners.repo, movable: false, cwd: lead.cwd, online: lead.online, ...(candidates.length > 1 ? { candidates } : {}) };
    }
  } else if (workspaceTask) {
    return { machine: LOCAL_MACHINE, source: "workspace", movable: false };
  }
  return { machine: placement.defaultMachine, source: "default", movable: true };
};

/** `freeSlots`: lanes the pane limit still allows; absent when the limit is off or the pane count is unknown. */
export type MachineCheck = {
  readonly machine: string; readonly verdict: LaunchVerdict; readonly summary: string; readonly freeSlots?: number;
  /** Admission inputs from the same observation; absent for an unobservable or offline machine. */
  readonly paneCap?: number; readonly paneCount?: number; readonly paneIds?: readonly string[];
};

const freeSlots = (panes: number, t: GuardThresholds): { freeSlots?: number } =>
  t.panesMax > 0 && panes >= 0 ? { freeSlots: Math.max(0, t.panesMax - panes) } : {};

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
  if (machine === LOCAL_MACHINE) return {
    machine, verdict: canLaunch(s, config.guard), summary: summaryOf(s.memFreePct, s.diskFreeGb, s.panes), ...freeSlots(s.panes, config.guard),
    paneCap: config.guard.panesMax, paneCount: s.panes, paneIds: seen.panes.map((p) => p.pane_id),
  };
  const panes = s.panes >= 0 ? seen.panes.length : -1;
  const result: SampleResult = {
    ok: true,
    sample: { os: seen.os, load1: s.load1, memFreePct: s.memFreePct, swapFreeGb: s.swapFreeGb, swapTotalGb: s.swapTotalGb, diskFreeGb: s.diskFreeGb },
  };
  const guard: GuardThresholds = { ...config.guard, ...seen.guard };
  return {
    machine, verdict: machineVerdict(result, panes, guard, machine), summary: summaryOf(s.memFreePct, s.diskFreeGb, panes), ...freeSlots(panes, guard),
    paneCap: guard.panesMax, paneCount: panes, paneIds: seen.panes.map((p) => p.pane_id),
  };
};

/** Local keeps the legacy `CAN_LAUNCH` / `HOLD <reasons>`; a remote line names its machine. */
export const verdictLine = (machine: string, v: LaunchVerdict): string => {
  const tag = machine === LOCAL_MACHINE ? "" : ` machine=${machine}`;
  return v.ok ? `CAN_LAUNCH${tag}` : `HOLD${tag} ${v.reasons.join(" | ")}`;
};

export const placementLine = (p: Placement): string =>
  `PLACEMENT machine=${p.machine} source=${p.source}${p.rule === undefined ? "" : ` rule=${p.rule}`}${p.cwd === undefined ? "" : ` cwd=${p.cwd}`}`;

/**
 * `dori placement`: one line per declared repo and declaring runner (`WORKSPACE repo=R machine=M path=P
 * runner=online|offline`, by repo then machine; several runners of one repo are launch candidates), one per repo only detected (`DETECTED ...`, information: it follows
 * defaultMachine), one per runner that reported a lane worktree root (`WORKTREES machine=M root=P`), then
 * `DEFAULT machine=D fallback=a,b|-`.
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
    const pairs = at.filter((a, i) => at.findIndex((b) => b.machine === a.machine) === i).sort((a, b) => a.machine.localeCompare(b.machine));
    for (const a of pairs) lines.push(`WORKSPACE repo=${repo} machine=${a.machine} path=${a.path} runner=${a.online ? "online" : "offline"}`);
  }
  const detected = reports.flatMap((r) => r.detected.filter((e) => !declared.has(e.repo.toLowerCase())).map((e) => ({ ...e, machine: r.machine })))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.machine.localeCompare(b.machine));
  for (const d of detected) lines.push(`DETECTED repo=${d.repo} machine=${d.machine} path=${d.path} (no runner declares it)`);
  for (const r of reports.filter((r) => r.worktreeRoot !== undefined).sort((a, b) => a.machine.localeCompare(b.machine))) lines.push(`WORKTREES machine=${r.machine} root=${r.worktreeRoot}`);
  lines.push(`DEFAULT machine=${placement.defaultMachine} fallback=${placement.fallback.length ? placement.fallback.join(",") : "-"}`);
  return lines;
};

export type LaunchPlan = {
  readonly placement: Placement;
  /** The machine the launch goes to (a fallback with room, else the placed one) and its verdict. */
  readonly check: MachineCheck;
  /** PLACEMENT, then PLACEMENT_FALLBACK when the launch moved, or PLACEMENT_CANDIDATES (and the held candidates' HOLD lines). */
  readonly lines: readonly string[];
};

/** `PLACEMENT_CANDIDATES repo=R machines=a,b chosen=M|none` for a placement with several declaring runners. */
export const candidatesLine = (p: Placement, chosen: string): string =>
  `PLACEMENT_CANDIDATES repo=${p.rule} machines=${(p.candidates ?? []).map((c) => c.machine).join(",")} chosen=${chosen}`;

const offlineHold = (machine: string, repo: string | undefined): MachineCheck =>
  ({ machine, verdict: { ok: false, reasons: [`runner ${machine} that owns ${repo} is offline; the launch waits for it`] }, summary: "" });

/**
 * Several runners declare the repo: every online candidate is checked; the launch goes to defaultMachine when it has room,
 * else to the first candidate with room, in that runner's declared checkout. None with room holds on the preferred one
 * (`p.machine`), with a HOLD line for every other candidate.
 */
const planCandidates = async (p: Placement, candidates: readonly PlacementCandidate[], placement: PlacementConfig, check: (machine: string) => Promise<MachineCheck>): Promise<LaunchPlan> => {
  const checks: { c: PlacementCandidate; check: MachineCheck }[] = [];
  for (const c of candidates) if (c.online) checks.push({ c, check: await check(c.machine) });
  const pick = preferred(checks.filter((x) => x.check.verdict.ok).map((x) => ({ ...x, machine: x.c.machine })), placement);
  if (pick) {
    const placed: Placement = { ...p, machine: pick.c.machine, cwd: pick.c.cwd, online: true };
    return { placement: placed, check: pick.check, lines: [placementLine(placed), candidatesLine(placed, pick.c.machine)] };
  }
  const held = candidates.filter((c) => c.machine !== p.machine)
    .map((c) => { const x = checks.find((y) => y.c.machine === c.machine); return verdictLine(c.machine, (x?.check ?? offlineHold(c.machine, p.rule)).verdict); });
  const lead = checks.find((x) => x.c.machine === p.machine)!.check;
  return { placement: p, check: lead, lines: [placementLine(p), candidatesLine(p, "none"), ...held] };
};

/**
 * The machines a launch placed at `p` may go to, in the order planLaunch tries them: none while its owning runner is
 * offline, the online candidates (defaultMachine first) when several runners declare the repo, the placed machine then
 * the `fallback` machines for a movable placement, else the placed machine alone.
 */
export const placementTargets = (p: Placement, placement: PlacementConfig): string[] => {
  if (p.online === false) return [];
  if (p.candidates) {
    const online = p.candidates.filter((c) => c.online).map((c) => c.machine);
    return online.includes(placement.defaultMachine) ? [placement.defaultMachine, ...online.filter((m) => m !== placement.defaultMachine)] : online;
  }
  return p.movable ? [p.machine, ...placement.fallback.filter((m) => m !== p.machine)] : [p.machine];
};

/**
 * Places a launch and checks it there; a movable placement on HOLD takes the first `fallback` machine with room. A
 * launch placed on a declaring runner that is offline holds for it unchecked: it never moves to another machine. A repo
 * several runners declare goes to one of those candidates (planCandidates); all of them offline holds like one.
 */
export const planLaunch = async (input: PlacementInput, placement: PlacementConfig, check: (machine: string) => Promise<MachineCheck>, reports: readonly RunnerPlacement[] = []): Promise<LaunchPlan> => {
  const p = resolvePlacement(input, placement, reports);
  const lines = [placementLine(p)];
  if (p.online === false) return { placement: p, check: offlineHold(p.machine, p.rule), lines: p.candidates ? [...lines, candidatesLine(p, "none")] : lines };
  if (p.candidates) return planCandidates(p, p.candidates, placement, check);
  const first = await check(p.machine);
  if (first.verdict.ok || !p.movable) return { placement: p, check: first, lines };
  for (const machine of placement.fallback) {
    if (machine === p.machine) continue;
    const next = await check(machine);
    if (next.verdict.ok) return { placement: p, check: next, lines: [...lines, `PLACEMENT_FALLBACK ${p.machine} -> ${machine} (${first.verdict.reasons.join(" | ")})`] };
  }
  return { placement: p, check: first, lines };
};
