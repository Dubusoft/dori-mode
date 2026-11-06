import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LANE_SANDBOX_TEMPLATE = fileURLToPath(new URL("../templates/lane-sandbox.sh", import.meta.url));

export const installedLaneSandbox = (home: string): string => join(home, ".local", "bin", "lane-sandbox");

/**
 * Replaces an installed `~/.local/bin/lane-sandbox` that differs from the template with the template, keeping the old
 * copy as `lane-sandbox.bak`, so new lanes get the template's mounts (their own lane token and the runner socket). The new
 * file is renamed into place, so a lane whose shell is still reading the old script keeps its own inode. A missing install
 * is left missing: launch then passes lanes through with SANDBOX_SKIPPED, as before. Returns the line to log, if any.
 */
export const refreshLaneSandbox = (home: string, template: string = LANE_SANDBOX_TEMPLATE): string | undefined => {
  const installed = installedLaneSandbox(home);
  if (!existsSync(installed)) return undefined;
  const want = readFileSync(template);
  if (readFileSync(installed).equals(want)) return undefined;
  copyFileSync(installed, `${installed}.bak`);
  const next = `${installed}.new-${process.pid}`;
  writeFileSync(next, want);
  chmodSync(next, 0o755);
  renameSync(next, installed);
  return `LANE_SANDBOX_UPDATED ${installed} from templates/lane-sandbox.sh; the previous copy is ${installed}.bak`;
};
