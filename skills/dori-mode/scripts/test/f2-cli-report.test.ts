import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

import { JsonLaneReports } from "../src/lane-reports.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

setDefaultTimeout(30_000);

const T0 = Date.parse("2026-01-01T12:00:00Z");
const RECOVERED = T0 + 5_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); });

const cli = async (dir: string, args: string[], env: Record<string, string>) => {
  await Bun.write(join(dir, "config.json"), "{}");
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "report", ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "config.json"), DORI_STATE_DIR: dir, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

const setup = async (patch: Partial<Lane> = {}) => {
  const state = withState();
  cleanups.push(state.done);
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  await deps.registry.write({
    key: "demo-lane", title: "t", thread: "discord:1/2", pane: "w:p7", brief: join(state.dir, "b.md"), done: "merged acme/app#1",
    openedAt: new Date(T0).toISOString(), ...patch,
  });
  return state.dir;
};

test("a CLI report row carries the lane's current generation", async () => {
  const dir = await setup({ lastRecoveryAt: RECOVERED });
  const r = await cli(dir, ["demo-lane", "question", "--text", "which base?"], { DORI_LANE_KEY: "demo-lane" });
  expect(r.code).toBe(0);
  expect(new JsonLaneReports(dir).list()).toMatchObject([{ lane: "demo-lane", generation: RECOVERED }]);
});

test("a CLI report row of a lane never recovered stays unfenced (generation 0)", async () => {
  const dir = await setup();
  await cli(dir, ["demo-lane", "progress", "--text", "x"], { DORI_LANE_KEY: "demo-lane" });
  expect(new JsonLaneReports(dir).list()).toMatchObject([{ generation: 0 }]);
});

test("a multi-line --text and --evidence keep their newlines, and secrets are still redacted", async () => {
  const dir = await setup();
  const token = "ghp_" + "a".repeat(36);
  const r = await cli(dir, ["demo-lane", "done", "--text", `line one\nline two\n- item ${token}`, "--evidence", "sha abc\nPR #4"], { DORI_LANE_KEY: "demo-lane" });
  expect(r.code).toBe(0);
  const [row] = new JsonLaneReports(dir).list();
  expect(row?.text).toStartWith("line one\nline two\n- item ");
  expect(row?.text).not.toContain(token);
  expect(row?.evidence).toBe("sha abc\nPR #4");
});
