import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerClient } from "../src/runner/client.ts";
import { Outbox } from "../src/runner/outbox.ts";
import { serveRunner } from "../src/runner/serve.ts";
import { RunnerState } from "../src/runner/state.ts";
import { fakeClock } from "./fakes.ts";

// With the fake clock every backoff sleep resolves at once and an in-memory connect fails without I/O. The reconnect
// loops must still give the event loop a turn per attempt, or an abort scheduled as a macrotask never runs.
const STARVED_AFTER = 10_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const failingClient = (abort: AbortController) => {
  const dir = mkdtempSync(join(tmpdir(), "runner-yield-"));
  dirs.push(dir);
  const clock = fakeClock(1_000);
  const state = new RunnerState(dir, { now: clock.now });
  state.boot();
  const outbox = new Outbox(dir, { now: clock.now });
  const counts = { attempts: 0, starved: false };
  const client = new RunnerClient({ label: "local", hostId: "host-1" }, {
    connect: async () => {
      counts.attempts += 1;
      if (counts.attempts >= STARVED_AFTER) { counts.starved = true; abort.abort(); }
      throw new Error("refused");
    },
    outbox, state, clock,
  });
  return { client, clock, counts, close: () => { outbox.close(); state.close(); } };
};

test("RunnerClient.run lets a macrotask abort it while every connect fails and sleeps resolve at once", async () => {
  const abort = new AbortController();
  const rig = failingClient(abort);
  setImmediate(() => { abort.abort(); });
  await rig.client.run(abort.signal);
  rig.close();
  expect(rig.counts.starved).toBe(false);
  expect(rig.counts.attempts).toBeLessThanOrEqual(2);
});

test("serveRunner lets a macrotask abort it while every connect fails and sleeps resolve at once", async () => {
  const abort = new AbortController();
  const rig = failingClient(abort);
  const log: string[] = [];
  setImmediate(() => { abort.abort(); });
  await serveRunner({
    client: rig.client, latest: () => undefined, clock: rig.clock, every: () => () => {}, heartbeatMs: 15_000,
    log: (line) => { log.push(line); },
  }, abort.signal);
  rig.close();
  expect(rig.counts.starved).toBe(false);
  expect(rig.counts.attempts).toBeLessThanOrEqual(2);
  expect(log.length).toBeLessThanOrEqual(2);
});
