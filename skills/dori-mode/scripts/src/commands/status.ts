import { loadConfig } from "../config.ts";
import { Registry } from "../registry.ts";
import { realClock, run, setDefaultRunTimeout } from "../run.ts";
import { defaultRunnerDir } from "../runner/fs-safety.ts";
import { StoreError } from "../store.ts";
import { convertJsonState } from "../store-convert.ts";
import { BUILT_IN } from "../tunables.ts";
import { die } from "./context.ts";

/** `dori status [--json | --page N]`: the one-screen summary, or every lane as JSON. */
export const statusMain = async (args: readonly string[]): Promise<number> => {
  const json = args.length === 1 && args[0] === "--json";
  const paged = args.length === 2 && args[0] === "--page" && /^[1-9]\d*$/.test(args[1] ?? "");
  if (args.length && !json && !paged) { console.error("usage: dori status [--json | --page N]"); return 1; }
  const page = paged ? Number(args[1]) : 1;
  const { collectStatus, statusPage } = await import("../status.ts");
  const cfg = await loadConfig();
  await convertJsonState(cfg.stateDir);
  setDefaultRunTimeout(cfg.runTimeoutMs);
  try {
    const registry = new Registry(cfg.stateDir);
    const status = await collectStatus({ run, clock: realClock, config: cfg, tunables: BUILT_IN, registry, runnerDir: defaultRunnerDir() });
    console.log(json ? JSON.stringify(status, null, 2) : statusPage(status, page));
  } catch (e) {
    // A state dir whose json store did not convert has no database to read (STORE_CONVERT_FAILED was printed above).
    if (e instanceof StoreError) die(e.message);
    throw e;
  }
  return 0;
};
