import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig, loadConfig } from "../src/config.ts";
import { Registry } from "../src/registry.ts";
import { PRE_SQLITE_FILE, SQLITE_FILE, SqliteStore, type StoreKind, openStore, storeOnDisk } from "../src/store.ts";
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

test("a config with a runners section or progressTemplate loads with both ignored, valid or malformed", async () => {
  const state = withState();
  cleanups.push(state.done);
  const path = join(state.dir, "config.json");
  for (const runners of [{ listen: "100.64.0.1:7411", mode: { mini: "shadow" }, restartCircuit: { max: 3 } }, { listen: "0.0.0.0:7411" }, [], { restartCircuit: "x" }]) {
    await Bun.write(path, JSON.stringify({ runners, progressTemplate: "x", store: "json" }));
    const config = await loadConfig(path, "/home/ana");
    expect("runners" in config).toBe(false);
    expect("progressTemplate" in config).toBe(false);
    expect(config.store).toBe(storeOnDisk(config.stateDir));
  }
  expect("runners" in defaultConfig("/home/ana")).toBe(false);
});

test("the store follows the files on disk, not a store key in the config", async () => {
  const dir = stateFor("sqlite");
  const path = join(dir, "config.json");
  await Bun.write(path, JSON.stringify({ stateDir: dir, store: "json" }));
  expect((await loadConfig(path, "/home/ana")).store).toBe("sqlite");
});

test("pre-sqlite marker with no journal and no database: openStore stops with STORE_MISSING", () => {
  const state = withState();
  cleanups.push(state.done);
  writeFileSync(join(state.dir, PRE_SQLITE_FILE), "{}");
  expect(storeOnDisk(state.dir)).toBe("sqlite");
  expect(() => openStore(state.dir, storeOnDisk(state.dir))).toThrow("STORE_MISSING");
  expect(existsSync(join(state.dir, SQLITE_FILE))).toBe(false);
});
