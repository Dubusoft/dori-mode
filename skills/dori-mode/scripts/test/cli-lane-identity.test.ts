import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultRunnerDir } from "../src/runner/fs-safety.ts";
import { LANES_FILE } from "../src/runner/lanes.ts";
import { LANE_IDENTITY_FILE, readLaneIdentity } from "../src/runner/lane-identity.ts";
import { fakeLaneSocket } from "./fake-lane-socket.ts";

// Each case spawns `bun src/cli.ts`; process startup under a loaded full run outgrows bun's default 5 s.
setDefaultTimeout(30_000);

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "cli-lane-id-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A state dir that does not exist: lead dispatch of `hold list` creates it (withStateLockSync), lane mode never does. */
const stateDir = () => join(dir, "state-must-not-exist");

const cli = async (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "no-config.json"), DORI_STATE_DIR: stateDir(), ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

/** The runner's lanes.json in the spawned CLI's HOME, as RunnerLanes.adopt writes it. */
const writeLanes = (text: string) => {
  const runnerDir = defaultRunnerDir(dir);
  mkdirSync(runnerDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(runnerDir, LANES_FILE), text, { mode: 0o600 });
};
const adopted = (key: string, pane: string) => ({
  [key]: { key, pane, tab: "w:t1", cwd: "/work", tokenHash: "00".repeat(32), profile: "", mode: "ulw", model: "m", startedAt: 1, adopted: true },
});

test("an adopted lane's pane stays a lane with its runner socket gone: lead-only commands exit 2 with no state access", async () => {
  writeLanes(JSON.stringify(adopted("adopted-lane", "w:p7")));
  const r = await cli(["hold", "list"], { HERDR_PANE_ID: "w:p7" });
  expect(r.code).toBe(2);
  expect(r.err).toStartWith("DORI_CLI_LANE_ONLY hold: inside a lane dori takes only report");
  expect(existsSync(stateDir())).toBe(false);
  // The same with a state dir no process can create (gate probe E1): no mkdir is attempted.
  const ro = await cli(["hold", "list"], { HERDR_PANE_ID: "w:p7", DORI_STATE_DIR: "/proc/dori-cli-lane-identity-state" });
  expect(ro.code).toBe(2);
  expect(ro.err).toStartWith("DORI_CLI_LANE_ONLY hold:");
  expect(ro.err).not.toContain("ENOENT");
});

test("a pane the socket does not name but lanes.json maps is still that lane", async () => {
  writeLanes(JSON.stringify(adopted("adopted-lane", "w:p7")));
  const sock = fakeLaneSocket(dir, () => ({ ok: true }));
  try {
    const r = await cli(["hold", "list"], { HERDR_PANE_ID: "w:p7" });
    expect(r.code).toBe(2);
    expect(r.err).toStartWith("DORI_CLI_LANE_ONLY hold:");
    expect(existsSync(stateDir())).toBe(false);
  } finally { sock.close(); }
});

test("an unreadable lanes.json with no socket fails closed with LANE_IDENTITY_UNKNOWN, never lead dispatch", async () => {
  writeLanes("{not json");
  const r = await cli(["hold", "list"], { HERDR_PANE_ID: "w:p7" });
  expect(r.code).toBe(2);
  expect(r.err).toStartWith("LANE_IDENTITY_UNKNOWN pane w:p7:");
  expect(existsSync(stateDir())).toBe(false);
});

test("the lead stays the lead: a pane no runner record maps, and no pane at all", async () => {
  writeLanes(JSON.stringify(adopted("adopted-lane", "w:p7")));
  for (const env of [{ HERDR_PANE_ID: "lead:p1" }, {}] as Record<string, string>[]) {
    const r = await cli(["hold", "list"], env);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toBe("[]");
  }
});

test("readLaneIdentity: mapped, unmapped, absent and malformed lanes.json", () => {
  expect(LANE_IDENTITY_FILE).toBe(LANES_FILE);
  const runnerDir = defaultRunnerDir(dir);
  expect(readLaneIdentity(runnerDir, "w:p7")).toEqual({ kind: "none" });
  writeLanes(JSON.stringify({ ...adopted("a", "w:p1"), ...adopted("b", "w:p7") }));
  expect(readLaneIdentity(runnerDir, "w:p7")).toEqual({ kind: "lane", key: "b" });
  expect(readLaneIdentity(runnerDir, "w:p9")).toEqual({ kind: "none" });
  for (const bad of ["{", "[]", "null", JSON.stringify({ a: { key: "a" } }), JSON.stringify({ a: "w:p7" })]) {
    writeLanes(bad);
    expect(readLaneIdentity(runnerDir, "w:p7").kind).toBe("unreadable");
  }
});
