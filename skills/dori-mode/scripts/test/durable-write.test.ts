import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendFileDurable, replaceFileAtomic, replaceFileDurable } from "../src/durable-write.ts";
import { saveJsonFile } from "../src/store.ts";

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

test.each([
  ["replaceFileAtomic", replaceFileAtomic],
  ["replaceFileDurable", replaceFileDurable],
] as const)("%s removes its tmp file when the replace fails", (_name, replace) => {
  const dir = scratch();
  const path = join(dir, "state.json");
  mkdirSync(path);
  writeFileSync(join(path, "occupied"), "x");
  expect(() => replace(path, "lost", 0o600)).toThrow();
  expect(readdirSync(dir)).toEqual(["state.json"]);
});

test("processes saving one path at once each finish, and the file holds one whole save with no tmp left", async () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const writers = 4;
  const child = (id: number): string => `import { saveJsonFile } from ${JSON.stringify(join(import.meta.dir, "../src/store.ts"))};
    const value = { id: ${id}, pad: "${"x".repeat(64 * 1024)}" };
    for (let i = 0; i < 200; i++) saveJsonFile(${JSON.stringify(path)}, value);`;
  const procs = Array.from({ length: writers }, (_, id) => Bun.spawn([process.execPath, "-e", child(id)], { stderr: "pipe" }));
  const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
  expect(results).toEqual(Array.from({ length: writers }, () => ({ code: 0, err: "" })));
  const saved = JSON.parse(readFileSync(path, "utf8")) as { id: number; pad: string };
  expect(saved.id).toBeGreaterThanOrEqual(0);
  expect(saved.id).toBeLessThan(writers);
  expect(saved.pad).toHaveLength(64 * 1024);
  expect(readdirSync(dir)).toEqual(["state.json"]);
  saveJsonFile(path, { id: -1 });
  expect(readFileSync(path, "utf8")).toBe('{"id":-1}');
}, 60_000);

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
