import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig, loadConfig, OBSOLETE_CONFIG_KEYS, runnerMode, warnObsoleteKeys } from "../src/config.ts";
import { Registry } from "../src/registry.ts";
import { SQLITE_FILE, SqliteStore, type StoreKind } from "../src/store.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const baseLane = { title: "t", thread: "discord:1", brief: "b", done: "d", openedAt: "2026-01-01T00:00:00.000Z" };

/** A state dir whose journal store is `kind`; lanes are JSON files under lanes/ in both. */
const stateFor = (kind: StoreKind): string => {
  const state = withState();
  cleanups.push(state.done);
  if (kind === "sqlite") new SqliteStore(join(state.dir, SQLITE_FILE), { create: true }).close();
  mkdirSync(join(state.dir, "lanes"), { recursive: true });
  return state.dir;
};

for (const kind of ["json", "sqlite"] as const) {
  test(`${kind} store: a lane file without any runner field reads and writes`, async () => {
    const dir = stateFor(kind);
    writeFileSync(join(dir, "lanes", "plain.json"), JSON.stringify({ key: "plain", ...baseLane }));
    const registry = new Registry(dir);
    const lane = await registry.read("plain");
    expect(lane?.runner).toBeUndefined();
    expect(lane?.runnerAdoptedAt).toBeUndefined();
    expect(lane?.runnerStaleSince).toBeUndefined();
    expect(lane?.lastRunnerReportAt).toBeUndefined();
    expect((await registry.list()).map((l) => l.key)).toEqual(["plain"]);
    await registry.patch("plain", { title: "renamed" });
    const written = JSON.parse(readFileSync(registry.path("plain"), "utf8"));
    expect(written.title).toBe("renamed");
    expect("runner" in written).toBe(false);
  });

  test(`${kind} store: a lane file with removed and unknown fields reads and writes, keeping them`, async () => {
    const dir = stateFor(kind);
    writeFileSync(join(dir, "lanes", "old.json"), JSON.stringify({
      key: "old", ...baseLane,
      lastRemoteReport: "[REPORT] x", remoteReportsSeen: [{ hash: "h", at: "2026-01-01T00:00:00.000Z" }], futureField: { a: 1 },
    }));
    const registry = new Registry(dir);
    expect((await registry.read("old"))?.lastRemoteReport).toBe("[REPORT] x");
    await registry.patch("old", { title: "again" });
    const written = JSON.parse(readFileSync(registry.path("old"), "utf8"));
    expect(written).toMatchObject({ title: "again", lastRemoteReport: "[REPORT] x", futureField: { a: 1 } });
    expect(written.remoteReportsSeen).toHaveLength(1);
  });

  test(`${kind} store: runner fields round-trip`, async () => {
    const dir = stateFor(kind);
    const registry = new Registry(dir);
    await registry.write({ key: "owned", ...baseLane, runner: "mini", runnerAdoptedAt: 5, runnerStaleSince: 6, lastRunnerReportAt: 7 });
    expect(await registry.read("owned")).toMatchObject({ runner: "mini", runnerAdoptedAt: 5, runnerStaleSince: 6, lastRunnerReportAt: 7 });
  });
}

test("a config without runners loads with the hub unconfigured and every machine off", async () => {
  const state = withState();
  cleanups.push(state.done);
  const path = join(state.dir, "config.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 7 }));
  const config = await loadConfig(path, "/home/ana");
  expect(config.runners).toBeUndefined();
  expect(runnerMode(config, "mini")).toBe("off");
  expect(defaultConfig("/home/ana").runners).toBeUndefined();
});

test("the runners section loads, with unlisted machines off, and a malformed one is refused", async () => {
  const state = withState();
  cleanups.push(state.done);
  const path = join(state.dir, "config.json");
  await Bun.write(path, JSON.stringify({ runners: { listen: "100.64.0.1:7411", mode: { mini: "shadow", box: "authoritative" }, restartCircuit: { max: 3 } } }));
  const config = await loadConfig(path, "/home/ana");
  expect(config.runners?.listen).toBe("100.64.0.1:7411");
  expect(runnerMode(config, "mini")).toBe("shadow");
  expect(runnerMode(config, "box")).toBe("authoritative");
  expect(runnerMode(config, "other")).toBe("off");
  for (const bad of [[], { mode: { mini: "on" } }, { listen: 5 }, { mode: [] }, { restartCircuit: "x" }]) {
    await Bun.write(path, JSON.stringify({ runners: bad }));
    await expect(loadConfig(path, "/home/ana")).rejects.toThrow(TypeError);
  }
});

test("an obsolete key warns once per process and is dropped; the shipped list starts empty", async () => {
  expect(OBSOLETE_CONFIG_KEYS).toEqual([]);
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    const warned = new Set<string>();
    expect(warnObsoleteKeys({ oldKey: 1, fine: 2 }, "c.json", ["oldKey", "other"], warned)).toEqual(["oldKey"]);
    warnObsoleteKeys({ oldKey: 1 }, "c.json", ["oldKey"], warned);
  } finally { console.error = original; }
  expect(lines.filter((l) => l.startsWith("CONFIG_KEY_OBSOLETE oldKey"))).toHaveLength(1);
});
