import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendFileDurable, replaceFileAtomic, replaceFileDurable } from "../src/durable-write.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "durable-write-"));
  dirs.push(dir);
  return dir;
};

test.each([
  ["replaceFileAtomic", replaceFileAtomic],
  ["replaceFileDurable", replaceFileDurable],
] as const)("%s replaces the contents with the given mode and leaves no tmp file", (_name, replace) => {
  const dir = scratch();
  const path = join(dir, "state.json");
  replace(path, "first", 0o600);
  expect(readFileSync(path, "utf8")).toBe("first");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  replace(path, "second", 0o640);
  expect(readFileSync(path, "utf8")).toBe("second");
  expect(statSync(path).mode & 0o777).toBe(0o640);
  expect(readdirSync(dir)).toEqual(["state.json"]);
});

test("replaceFileDurable writes through a caller-named tmp file and leaves none behind", () => {
  const dir = scratch();
  const path = join(dir, "supervisor.json");
  replaceFileDurable(path, "{}", 0o600, `${path}.tmp`);
  expect(readFileSync(path, "utf8")).toBe("{}");
  expect(readdirSync(dir)).toEqual(["supervisor.json"]);
});

test("appendFileDurable creates the file with the given mode, even for empty data, and appends in order", () => {
  const dir = scratch();
  const path = join(dir, "events.log");
  appendFileDurable(path, "", 0o600);
  expect(readFileSync(path, "utf8")).toBe("");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  appendFileDurable(path, "a\n", 0o600);
  appendFileDurable(path, "é\n", 0o600);
  expect(readFileSync(path, "utf8")).toBe("a\né\n");
  expect(readdirSync(dir)).toEqual(["events.log"]);
});

test("appendFileDurable keeps an existing file's contents and mode", () => {
  const dir = scratch();
  const path = join(dir, "events.log");
  writeFileSync(path, "old\n", { mode: 0o644 });
  appendFileDurable(path, "new\n", 0o600);
  expect(readFileSync(path, "utf8")).toBe("old\nnew\n");
  expect(statSync(path).mode & 0o777).toBe(0o644);
});
