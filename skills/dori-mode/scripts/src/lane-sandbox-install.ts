import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LANE_SANDBOX_TEMPLATE = fileURLToPath(new URL("../templates/lane-sandbox.sh", import.meta.url));
/** The macOS (Seatbelt) wrapper `dori runner install` puts on a Mac runner; same inputs as the Linux one. */
export const LANE_SANDBOX_MACOS_TEMPLATE = fileURLToPath(new URL("../templates/lane-sandbox-macos.sh", import.meta.url));

export const installedLaneSandbox = (home: string): string => join(home, ".local", "bin", "lane-sandbox");

/**
 * Replaces an installed `~/.local/bin/lane-sandbox` that differs from the template with the template, keeping the old
 * copy as `lane-sandbox.bak`, so new lanes get the template's mounts (their own lane token and the runner socket). The new
 * file is renamed into place, so a lane whose shell is still reading the old script keeps its own inode. A missing install
 * is left missing: launch then refuses local lanes (SANDBOX_MISSING) and `dori doctor` reports it. Returns the line to log, if any.
 */
export const refreshLaneSandbox = (home: string, template?: string, platform: NodeJS.Platform = process.platform): string | undefined => {
  template ??= platform === "darwin" ? LANE_SANDBOX_MACOS_TEMPLATE : LANE_SANDBOX_TEMPLATE;
  const installed = installedLaneSandbox(home);
  if (!existsSync(installed)) return undefined;
  const want = readFileSync(template);
  if (readFileSync(installed).equals(want)) return undefined;
  copyFileSync(installed, `${installed}.bak`);
  const next = `${installed}.new-${process.pid}`;
  writeFileSync(next, want);
  chmodSync(next, 0o755);
  renameSync(next, installed);
  return `LANE_SANDBOX_UPDATED ${installed} from templates/${basename(template)}; the previous copy is ${installed}.bak`;
};
