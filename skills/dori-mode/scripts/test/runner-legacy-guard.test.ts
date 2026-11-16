import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LEGACY_GUARD_AGENT_FILES, legacyGuardAgentFiles, removeLegacyGuardAgent } from "../src/runner/legacy-guard.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

const home = (): string => {
  const path = mkdtempSync(join(tmpdir(), "dori-legacy-guard-"));
  homes.push(path);
  return path;
};

test("lists and removes legacy guard agent files", () => {
  const root = home();
  const dir = join(root, ".dori");
  mkdirSync(dir);
  writeFileSync(join(dir, LEGACY_GUARD_AGENT_FILES[0]), "legacy");
  writeFileSync(join(dir, LEGACY_GUARD_AGENT_FILES[2]), "version");

  expect(legacyGuardAgentFiles(root)).toEqual([
    join(dir, LEGACY_GUARD_AGENT_FILES[0]),
    join(dir, LEGACY_GUARD_AGENT_FILES[2]),
  ]);
  expect(removeLegacyGuardAgent(root)).toEqual([LEGACY_GUARD_AGENT_FILES[0], LEGACY_GUARD_AGENT_FILES[2]]);
  expect(legacyGuardAgentFiles(root)).toEqual([]);
});

test("returns no files when no legacy guard agent is installed", () => {
  const root = home();
  expect(legacyGuardAgentFiles(root)).toEqual([]);
  expect(removeLegacyGuardAgent(root)).toEqual([]);
  expect(existsSync(join(root, ".dori"))).toBe(false);
});
