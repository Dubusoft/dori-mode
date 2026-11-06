import type { DoriConfig, GuardThresholds, PlacementConfig } from "./config.ts";
import { doneRepos } from "./launch.ts";
import { LaneOpsError, type LaneOps } from "./lane-ops.ts";
import { type SampleResult, UNSUPPORTED_SHELL } from "./remote-guard.ts";
import { canLaunch, type LaunchVerdict } from "./routing.ts";

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
 * cannot host a lane, so it holds.
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
    sample: { version: "runner", os: seen.os, load1: s.load1, memFreePct: s.memFreePct, swapFreeGb: s.swapFreeGb, swapTotalGb: s.swapTotalGb, diskFreeGb: s.diskFreeGb },
  };
  return { machine, verdict: machineVerdict(result, panes, config.guard, machine), summary: summaryOf(s.memFreePct, s.diskFreeGb, panes) };
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
