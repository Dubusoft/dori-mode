import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BOOT_PREP, renderTemplate } from "./setup.ts";

export const BOOT_PREP_TEMPLATE = fileURLToPath(new URL(`../templates/${BOOT_PREP}`, import.meta.url));

const SUPERVISOR_UNIT_FILE = "dori-supervisor.service";

/** The path of the first `ExecStartPre=` line of a unit file, without systemd's `-`, `@`, `+` or `!` prefixes. */
const execStartPre = (unit: string): string | undefined => {
  const m = /^ExecStartPre=[-@+!:]*\s*(\S+)/m.exec(unit);
  return m?.[1];
};

/**
 * Replaces the supervisor unit's ExecStartPre script with the boot-prep template when it differs, keeping the old copy
 * as `<script>.bak`, so a restart no longer runs an outdated script. The new file is renamed into place. A missing unit,
 * a unit without ExecStartPre, or a missing script is left alone. Returns the line to log, if any.
 */
export const refreshBootPrep = (
  home: string,
  unitDir: string = join(home, ".config", "systemd", "user"),
  template: string = BOOT_PREP_TEMPLATE,
): string | undefined => {
  const unitFile = join(unitDir, SUPERVISOR_UNIT_FILE);
  if (!existsSync(unitFile)) return undefined;
  const installed = execStartPre(readFileSync(unitFile, "utf8"));
  if (!installed || !existsSync(installed)) return undefined;
  const want = Buffer.from(renderTemplate(readFileSync(template, "utf8"), {}));
  if (readFileSync(installed).equals(want)) return undefined;
  copyFileSync(installed, `${installed}.bak`);
  const next = `${installed}.new-${process.pid}`;
  writeFileSync(next, want);
  chmodSync(next, 0o755);
  renameSync(next, installed);
  return `BOOT_PREP_UPDATED ${installed} from templates/${BOOT_PREP}; the previous copy is ${installed}.bak`;
};
