import type { DoriConfig } from "./config.ts";
import { readRunnerRows } from "./runner/hub.ts";

/** Whether an OS label from a runner's guard sample (`win32` from node, `windows` from the PowerShell agent) is Windows. */
export const isWindowsOs = (os: string | undefined): boolean => os === "win32" || os === "windows";

/**
 * Why lanes on runner `label` run without a sandbox, or undefined when they run sandboxed. Windows has no lane sandbox,
 * so a runner whose machine reports Windows runs its lanes unsandboxed by design; any other runner does only when the
 * lead config opts it in with `runners.<label>.allowUnsandboxed`. Launch, doctor and status all say it with this text.
 */
export const unsandboxedReason = (config: Pick<DoriConfig, "runners">, label: string, os: string | undefined): string | undefined => {
  if (isWindowsOs(os)) return "is a Windows runner (Windows has no lane sandbox)";
  if (config.runners?.[label]?.allowUnsandboxed) return `is opted in with runners.${label}.allowUnsandboxed`;
  return undefined;
};

/** The OS runner `label` last reported in its guard sample (the hub's runners table), or undefined when none is known. */
export const runnerOs = (stateDir: string, label: string): string | undefined =>
  readRunnerRows(stateDir).find((row) => row.label === label)?.machine?.os;
