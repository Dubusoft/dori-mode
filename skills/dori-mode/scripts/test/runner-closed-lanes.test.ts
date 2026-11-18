import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Lane } from "../src/registry.ts";
import { enrollRunner, RunnerAuth, SupervisorAuth } from "../src/runner/auth.ts";
import { closedLanesOf } from "../src/runner/cleanup.ts";
import { RunnerClient } from "../src/runner/client.ts";
import { RunnerHub } from "../src/runner/hub.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { acceptRunners, type HubHooks } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import { connectUnix, listenUnix } from "../src/runner/unix-transport.ts";
import { realClock } from "../src/run.ts";
import { withState } from "./fakes.ts";

/**
 * `lanes.closed` with real parts: enrollment and the signed handshake over a real unix socket into `acceptRunners`, and a
 * real `RunnerClient` with real state and outbox files. The registry is a list of lane records.
 */

const AT = "2026-11-01T00:00:00.000Z";
const LANES = [
  { key: "r1-closed", cwd: "/w/repo-r1-closed", worktrees: ["/w/repo-r1-closed-2"], machine: "r1", openedAt: AT, closedAt: AT },
  { key: "r1-open", cwd: "/w/repo-r1-open", machine: "r1", openedAt: AT },
  { key: "r2-closed", cwd: "/w/repo-r2-closed", machine: "r2", openedAt: AT, closedAt: AT },
  { key: "local-closed", cwd: "/w/repo-local-closed", openedAt: AT, closedAt: AT },
] as unknown as Lane[];

let tmp: ReturnType<typeof withState>;
const cleanups: (() => void)[] = [];
beforeEach(() => { tmp = withState(); });
afterEach(() => { for (const done of cleanups.splice(0).reverse()) done(); tmp.done(); });

/** A supervisor with `hooks` and runner `r1` connected to it. */
const connected = async (hooks: Pick<HubHooks, "onClosedLanes">): Promise<RunnerClient> => {
  const supDir = join(tmp.dir, "sup"), runnerDir = join(tmp.dir, "runner");
  for (const d of [supDir, runnerDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const log = (): void => {};
  const auth = new SupervisorAuth(supDir, { now: realClock.now });
  const hub = new RunnerHub({ stateDir: supDir, now: realClock.now, monotonic: () => performance.now(), epoch: 2, commit: () => true });
  const controlPath = join(supDir, "control");
  const listener = listenUnix(controlPath);
  const stopAccept = acceptRunners(hub, listener, { auth, log, ...hooks });
  cleanups.push(() => { stopAccept(); listener.close(); hub.close(); auth.close(); });
  const connect = connectUnix(controlPath);
  const runnerAuth = new RunnerAuth(runnerDir);
  const enrolled = await enrollRunner({ auth: runnerAuth, connect, code: auth.issueCode("r1").code, label: "r1", hostId: "host-1", expectedFingerprint: auth.fingerprint });
  expect(enrolled.ok).toBe(true);
  const state = new RunnerState(runnerDir, { now: realClock.now });
  state.boot();
  const outbox = new Outbox(runnerDir, { now: realClock.now });
  const client = new RunnerClient({ label: "r1", hostId: "host-1" }, { connect, outbox, state, clock: realClock, auth: runnerAuth, log });
  expect(await client.connectOnce()).toMatchObject({ ok: true });
  cleanups.push(() => { client.rehello(); outbox.close(); state.close(); });
  return client;
};

test("a runner gets only its own closed lanes from the supervisor's registry", async () => {
  const asked: string[] = [];
  const client = await connected({ onClosedLanes: async (label) => { asked.push(label); return closedLanesOf(LANES, label === "local" ? undefined : label); } });
  expect(await client.closedLanes()).toEqual([{ key: "r1-closed", closedAt: Date.parse(AT), worktrees: ["/w/repo-r1-closed", "/w/repo-r1-closed-2"] }]);
  expect(asked).toEqual(["r1"]);
});

test("a supervisor that cannot list closed lanes, or fails reading them, answers with a refusal the sweep sees", async () => {
  const none = await connected({});
  await expect(none.closedLanes()).rejects.toThrow("this supervisor does not list closed lanes");
  for (const done of cleanups.splice(0).reverse()) done();
  const failing = await connected({ onClosedLanes: async () => { throw new Error("archive unreadable"); } });
  await expect(failing.closedLanes()).rejects.toThrow("archive unreadable");
});

test("closedLanes refuses without a connection", async () => {
  const client = await connected({ onClosedLanes: async () => [] });
  client.rehello();
  await expect(client.closedLanes()).rejects.toThrow("not connected to the supervisor");
});
