import type { DoriConfig, GuardThresholds, PlacementConfig } from "./config.ts";
import { diskGuardPath, type HostSample, sampleHost } from "./host-guard.ts";
import { doneRepos } from "./launch.ts";
import { type GuardMachine, listGuardMachines, type SampleResult, sampleMachine, UNSUPPORTED_SHELL } from "./remote-guard.ts";
import { canLaunch, type LaunchVerdict } from "./routing.ts";
import type { Runner } from "./run.ts";

/** The reserved machine name for this host. */
export const LOCAL_MACHINE = "local";

export type PlacementInput = { readonly machine?: string; readonly cwd?: string; readonly done: string; readonly pane?: string; readonly workspace?: string };

export type Placement = {
  /** "local" or a machine label. */
  readonly machine: string;
  readonly source: "flag" | "workspace" | "default";
  /** The `workspaces` key that matched ("*" included). */
  readonly rule?: string;
  /** Only a default placement may move to a fallback machine. */
  readonly movable: boolean;
};

const filled = (s: string | undefined): s is string => typeof s === "string" && s.trim() !== "";

/** The longest absolute-path key equal to `cwd` or a parent of it at a path boundary. */
const pathRule = (cwd: string, keys: readonly string[]): string | undefined =>
  keys
    .filter((key) => key.startsWith("/") && (cwd === key || cwd.startsWith(key.endsWith("/") ? key : `${key}/`)))
    .sort((a, b) => b.length - a.length)[0];

/** --machine wins; a workspace task follows `workspaces` (else local); anything else goes to `defaultMachine`. */
export const resolvePlacement = (input: PlacementInput, placement: PlacementConfig): Placement => {
  if (filled(input.machine)) return { machine: input.machine.trim(), source: "flag", movable: false };
  const repos = doneRepos(input.done);
  if (filled(input.cwd) || filled(input.pane) || filled(input.workspace) || repos.length) {
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
 * A machine whose shell cannot run the guard agent has no metrics, so only its pane count holds.
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

/** `herdr --machine <label> pane list` counted; -1 when it fails or its JSON is not the pane list shape. */
const remotePanes = async (run: Runner, label: string): Promise<number> => {
  const r = await run(["herdr", "--machine", label, "pane", "list"]);
  if (r.code !== 0) return -1;
  try {
    const panes = (JSON.parse(r.out) as { result?: { panes?: unknown } }).result?.panes;
    return Array.isArray(panes) ? panes.length : -1;
  } catch { return -1; }
};

export type CheckMachineDeps = {
  readonly sampleHost?: (run: Runner, dataPath: string) => Promise<HostSample>;
  readonly listMachines?: (run: Runner, overrides: Readonly<Record<string, string>>) => Promise<GuardMachine[]>;
  readonly sampleMachine?: (run: Runner, m: GuardMachine) => Promise<SampleResult>;
};

/** Whether `machine` ("local" or a label) has room for one more lane, with a short metrics summary ("" on failure). */
export const checkMachine = async (run: Runner, config: DoriConfig, machine: string, deps: CheckMachineDeps = {}): Promise<MachineCheck> => {
  if (machine === LOCAL_MACHINE) {
    const s = await (deps.sampleHost ?? ((r, path) => sampleHost(r, path)))(run, diskGuardPath(config));
    return { machine, verdict: canLaunch(s, config.guard), summary: summaryOf(s.memFreePct, s.diskFreeGb, s.panes) };
  }
  const listed = await (deps.listMachines ?? listGuardMachines)(run, config.guardMachines);
  const m = listed.find((x) => x.label === machine);
  if (!m) return { machine, verdict: { ok: false, reasons: [`unknown machine ${machine}; see dori guard machines`] }, summary: "" };
  const [result, panes] = await Promise.all([(deps.sampleMachine ?? sampleMachine)(run, m), remotePanes(run, machine)]);
  return {
    machine,
    verdict: machineVerdict(result, panes, config.guard, machine),
    summary: result.ok ? summaryOf(result.sample.memFreePct, result.sample.diskFreeGb, panes) : "",
  };
};

/** Local keeps the legacy `CAN_LAUNCH` / `HOLD <reasons>`; a remote line names its machine. */
export const verdictLine = (machine: string, v: LaunchVerdict): string => {
  const tag = machine === LOCAL_MACHINE ? "" : ` machine=${machine}`;
  return v.ok ? `CAN_LAUNCH${tag}` : `HOLD${tag} ${v.reasons.join(" | ")}`;
};

export const placementLine = (p: Placement): string =>
  `PLACEMENT machine=${p.machine} source=${p.source}${p.rule === undefined ? "" : ` rule=${p.rule}`}`;

export type LaunchPlan = {
  readonly placement: Placement;
  /** The machine the launch goes to (a fallback with room, else the placed one) and its verdict. */
  readonly check: MachineCheck;
  /** PLACEMENT, then PLACEMENT_FALLBACK when the launch moved. */
  readonly lines: readonly string[];
};

/** Places a launch and checks it there; a movable placement on HOLD takes the first `fallback` machine with room. */
export const planLaunch = async (input: PlacementInput, placement: PlacementConfig, check: (machine: string) => Promise<MachineCheck>): Promise<LaunchPlan> => {
  const p = resolvePlacement(input, placement);
  const lines = [placementLine(p)];
  const first = await check(p.machine);
  if (first.verdict.ok || !p.movable) return { placement: p, check: first, lines };
  for (const machine of placement.fallback) {
    if (machine === p.machine) continue;
    const next = await check(machine);
    if (next.verdict.ok) return { placement: p, check: next, lines: [...lines, `PLACEMENT_FALLBACK ${p.machine} -> ${machine} (${first.verdict.reasons.join(" | ")})`] };
  }
  return { placement: p, check: first, lines };
};
