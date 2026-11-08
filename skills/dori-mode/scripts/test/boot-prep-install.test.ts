import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BOOT_PREP_TEMPLATE, refreshBootPrep } from "../src/boot-prep-install.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempDir = (): string => {
  const d = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dori-bootprep-"));
  dirs.push(d);
  return d;
};
const unitWith = (dir: string, pre: string): void =>
  writeFileSync(join(dir, "dori-supervisor.service"), `[Service]\n${pre}\nExecStart=/bin/true\n`);

test("an outdated boot-prep script is replaced, the old copy kept and the mode 755", () => {
  const dir = tempDir();
  const script = join(dir, "dori-boot-prep.sh");
  writeFileSync(script, "#!/bin/sh\nherdr tab create --label dori-lead\n");
  unitWith(dir, `ExecStartPre=-${script}`);

  expect(refreshBootPrep(dir, dir)).toBe(`BOOT_PREP_UPDATED ${script} from templates/dori-boot-prep.sh; the previous copy is ${script}.bak`);
  expect(readFileSync(script)).toEqual(readFileSync(BOOT_PREP_TEMPLATE));
  expect(statSync(script).mode & 0o777).toBe(0o755);
  expect(readFileSync(`${script}.bak`, "utf8")).toBe("#!/bin/sh\nherdr tab create --label dori-lead\n");
});

test("an identical script is left untouched", () => {
  const dir = tempDir();
  const script = join(dir, "dori-boot-prep.sh");
  writeFileSync(script, readFileSync(BOOT_PREP_TEMPLATE));
  unitWith(dir, `ExecStartPre=${script}`);

  expect(refreshBootPrep(dir, dir)).toBeUndefined();
  expect(existsSync(`${script}.bak`)).toBe(false);
});

test("a missing unit, a unit without ExecStartPre, or a missing script returns undefined", () => {
  const dir = tempDir();
  expect(refreshBootPrep(dir, dir)).toBeUndefined();

  unitWith(dir, "Restart=always");
  expect(refreshBootPrep(dir, dir)).toBeUndefined();

  const script = join(dir, "gone.sh");
  unitWith(dir, `ExecStartPre=${script}`);
  expect(refreshBootPrep(dir, dir)).toBeUndefined();
  expect(existsSync(script)).toBe(false);
});
