import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { adoptLegacyLanes } from "../src/runner/adopt-legacy.ts";
import type { AdoptInput } from "../src/lane-ops.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const setup = async (connected: (machine: string) => boolean = (machine) => machine !== "far") => {
  const s = withState();
  cleanups.push(s.done);
  const deps = depsFor(newWorld(), fakeClock(T0), s.dir);
  const lane = (key: string, extra: object) => ({ key, title: key, thread: "none", brief: join(s.dir, `${key}.md`), done: "x", openedAt: new Date(T0).toISOString(), status: "working", ...extra }) as unknown as Lane;
  await deps.registry.write(lane("local-a", { pane: "pa", tab: "ta", cwd: "/work/a", mode: "ulw", model: "m/a" }));
  await deps.registry.write(lane("remote-b", { machine: "mini", pane: "pb", tab: "tb", remoteCwd: "/r/b", mode: "mass-ulw", model: "m/b" }));
  await deps.registry.write(lane("sand-c", { pane: "pc", tab: "tc", sandbox: true }));
  await deps.registry.write(lane("far-d", { machine: "far", pane: "pd", tab: "td" }));
  await deps.registry.write(lane("owned-e", { pane: "pe", runner: "local" }));
  await deps.registry.write(lane("closed-f", { pane: "pf", closedAt: new Date(T0).toISOString() }));
  await deps.registry.write(lane("nopane-g", {}));
  const adopted: AdoptInput[] = [];
  const emitted: [string, string][] = [];
  const logs: string[] = [];
  let failKey: string | undefined;
  const run = () => adoptLegacyLanes({
    registry: deps.registry,
    ops: {
      adopt: async (input) => { if (failKey === input.key) { failKey = undefined; throw new Error("down"); } adopted.push(input); return { pane: input.pane, tab: "t", tokenFile: "f" }; },
      connected: (machine) => connected(machine ?? "local"),
    },
    emit: (id, line) => { emitted.push([id, line]); }, log: (line) => { logs.push(line); },
  });
  return { deps, adopted, emitted, logs, run, failOnce: (key: string) => { failKey = key; } };
};

test("an open lane without a runner is adopted once with its runner set, and never again", async () => {
  const t = await setup();
  expect((await t.run()).sort()).toEqual(["local-a", "remote-b"]);
  expect([...t.adopted].sort((x, y) => x.key.localeCompare(y.key))).toEqual([
    { key: "local-a", pane: "pa", cwd: "/work/a", mode: "ulw", model: "m/a" },
    { key: "remote-b", machine: "mini", pane: "pb", cwd: "/r/b", mode: "mass-ulw", model: "m/b" },
  ]);
  expect((await t.deps.registry.read("local-a"))?.runner).toBe("local");
  expect((await t.deps.registry.read("remote-b"))?.runner).toBe("mini");
  expect(await t.run()).toEqual([]);
  expect(t.adopted).toHaveLength(2);
});

test("closed, already owned and pane-less lanes are left alone", async () => {
  const t = await setup();
  await t.run();
  for (const key of ["closed-f", "nopane-g"]) expect((await t.deps.registry.read(key))?.runner).toBeUndefined();
  expect((await t.deps.registry.read("owned-e"))?.runner).toBe("local");
  expect(t.adopted.map((a) => a.key)).not.toContain("owned-e");
});

test("a sandboxed legacy local lane and a lane on a machine with no connected runner get one LANE_RUNNER_MIGRATION and stay unowned", async () => {
  const t = await setup();
  await t.run();
  await t.run();
  expect(new Set(t.emitted.map(([id]) => id))).toEqual(new Set(["lane-runner-migration:sand-c", "lane-runner-migration:far-d"]));
  expect(t.emitted.every(([, line]) => line.startsWith("LANE_RUNNER_MIGRATION "))).toBe(true);
  expect((await t.deps.registry.read("sand-c"))?.runner).toBeUndefined();
  expect((await t.deps.registry.read("far-d"))?.runner).toBeUndefined();
  expect(t.adopted.map((a) => a.key)).not.toContain("sand-c");
});

test("a failed lane.adopt leaves the lane unowned and logged; the next pass adopts it", async () => {
  const t = await setup();
  t.failOnce("local-a");
  const first = await t.run();
  expect(first).toEqual(["remote-b"]);
  expect(t.logs[0]).toStartWith("LANE_ADOPT_FAILED local-a runner=local down");
  expect((await t.deps.registry.read("local-a"))?.runner).toBeUndefined();
  expect(await t.run()).toEqual(["local-a"]);
});
