import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOmoLaneProfile, omoUserConfig } from "../src/runner/omo-profile.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "omo-profile-"));
  dirs.push(home);
  return home;
};
const LANE = { "dori-lane": { memory: { reflection: { sandbox: "off" } } } };

test("a home without an omo config gets one holding only the dori-lane profile", () => {
  const home = tempHome();
  expect(ensureOmoLaneProfile(home)).toBe(`OMO_LANE_PROFILE_ADDED ${omoUserConfig(home)}: profiles.dori-lane.memory.reflection.sandbox is off`);
  expect(JSON.parse(readFileSync(omoUserConfig(home), "utf8"))).toEqual({ profiles: LANE });
  expect(readdirSync(join(home, ".omo"))).toEqual(["omo.jsonc"]);
});

test("an existing JSONC config keeps its keys, other profiles and mode, is backed up, and is left alone on a second run", () => {
  const home = tempHome();
  const file = omoUserConfig(home);
  mkdirSync(join(home, ".omo"));
  const text = '{\n  // mine\n  "memory": { "agent": "x" },\n  "profiles": { "work": { "model": "m" }, "dori-lane": { "memory": { "reflection": { "sandbox": "auto", "model": "r" } } } },\n}\n';
  writeFileSync(file, text);
  chmodSync(file, 0o600);
  expect(ensureOmoLaneProfile(home)).toStartWith("OMO_LANE_PROFILE_ADDED ");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    memory: { agent: "x" },
    profiles: { work: { model: "m" }, "dori-lane": { memory: { reflection: { sandbox: "off", model: "r" } } } },
  });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(`${file}.bak.dori-lane`, "utf8")).toBe(text);
  const after = readFileSync(file, "utf8");
  expect(ensureOmoLaneProfile(home)).toBeUndefined();
  expect(readFileSync(file, "utf8")).toBe(after);
});

test("a symlinked config is rewritten at its target, and the link stays", () => {
  const home = tempHome();
  const target = join(home, "dotfiles-omo.jsonc");
  writeFileSync(target, '{"a":1}\n');
  mkdirSync(join(home, ".omo"));
  symlinkSync(target, omoUserConfig(home));
  expect(ensureOmoLaneProfile(home)).toBe(`OMO_LANE_PROFILE_ADDED ${target}: profiles.dori-lane.memory.reflection.sandbox is off`);
  expect(JSON.parse(readFileSync(omoUserConfig(home), "utf8"))).toEqual({ a: 1, profiles: LANE });
  expect(readFileSync(target, "utf8")).toBe(readFileSync(omoUserConfig(home), "utf8"));
});

test("a config that is not a JSONC object, or holds a non-object on the profile's path, throws and is not touched", () => {
  for (const text of ["[1]\n", '{"a":\n', '{"profiles":{"dori-lane":"x"}}\n']) {
    const home = tempHome();
    mkdirSync(join(home, ".omo"));
    writeFileSync(omoUserConfig(home), text);
    expect(() => ensureOmoLaneProfile(home)).toThrow();
    expect({ files: readdirSync(join(home, ".omo")), text: readFileSync(omoUserConfig(home), "utf8") }).toEqual({ files: ["omo.jsonc"], text });
  }
});
