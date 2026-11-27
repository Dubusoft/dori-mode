import { pruneRunnerConfig } from "./config-keys.ts";
import { defaultRunnerDir } from "./runner/fs-safety.ts";
import { RETIRED_POLICY_KEYS } from "./runner/policy.ts";
import { localRunnerConfigIO } from "./runner/runner-setup.ts";
import { HC_CORE_UNIT } from "./runtime/hc.ts";

export const SUPERVISOR_UNIT = "dori-supervisor.service";

/**
 * The systemd user units a lead host runs, in start order: hc-core (the hc core's autostart, a oneshot `hc server start`
 * that counts as up once enabled) and the supervisor. dori setup installs these, dori doctor checks them and dori status
 * lists them. A function, not a constant: this module loads inside setup.ts's import cycle, so nothing imported may be
 * read while it initialises.
 */
export const hostServices = (): string[] => [HC_CORE_UNIT, SUPERVISOR_UNIT];

/**
 * Removes the keys parsePolicy no longer reads (a retired `laneRuntime` among them) from the lead host's local runner
 * config (`<home>/.dori/runner/runner-config.json`), the way `dori runner setup` prunes it: pruneRunnerConfig, the old
 * text kept as `runner-config.json.bak`, one `SETUP_RUNNER_KEY_REMOVED <key> (<why>) from <path>` line per key (a retired
 * key's why is its RETIRED_POLICY_KEYS reason). An absent, unreadable or non-object file is left alone: the runner reports
 * it itself. Returns the removed keys. `dori setup --migrate` runs it.
 */
export const pruneLocalRunnerConfig = async (home: string, log: (line: string) => void): Promise<string[]> => {
  const io = localRunnerConfigIO(defaultRunnerDir(home));
  const old = await io.read();
  if (old === undefined) return [];
  let raw: unknown;
  try { raw = JSON.parse(old); } catch { return []; }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const pruned = pruneRunnerConfig(raw as Record<string, unknown>);
  if (!pruned.removed.length) return [];
  await io.backup(old);
  await io.write(`${JSON.stringify(pruned.next, null, 2)}\n`);
  for (const key of pruned.removed) {
    log(`SETUP_RUNNER_KEY_REMOVED ${key} (${Object.hasOwn(RETIRED_POLICY_KEYS, key) ? RETIRED_POLICY_KEYS[key] : "runner-config.json no longer reads it"}) from ${io.where}`);
  }
  return [...pruned.removed];
};
