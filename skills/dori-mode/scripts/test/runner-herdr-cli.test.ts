import { expect, test } from "bun:test";
import { RunnerUnavailable } from "../src/runner/call.ts";
import { runnerHerdrMain } from "../src/runner/herdr-cli.ts";
import type { RunnerRow } from "../src/runner/hub.ts";

const row = (label: string, proto: number): RunnerRow => ({ label, proto, maxGen: 1 } as unknown as RunnerRow);
const LANES = [{ key: "a", runner: "worker-a" }, { key: "b", runner: "worker-b" }, { key: "c", runner: "worker-a" }, { key: "old" }, { key: "lead-side", runner: "local" }];

const cli = (opts: { proto?: number; answer?: unknown; throws?: unknown } = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const sent: { label: string; type: string; body: unknown }[] = [];
  const deps = {
    calls: {
      call: async (label: string, type: string, body: unknown) => {
        sent.push({ label, type, body });
        if (opts.throws) throw opts.throws;
        return opts.answer ?? { cmdId: "x", state: "verified", detail: "read; herdr up", result: { action: "status", state: "up", managed: true, paused: false } };
      },
    } as never,
    rows: () => [row("worker-a", opts.proto ?? 4), row("local", 4)],
    lanes: async () => LANES,
    out: (line: string) => { out.push(line); }, err: (line: string) => { err.push(line); },
  };
  return { deps, out, err, sent };
};

test("status sends host.herdr to the machine's runner and prints its answer", async () => {
  const c = cli();
  expect(await runnerHerdrMain({ action: "status", machine: "worker-a", yes: false }, c.deps)).toBe(0);
  expect(c.sent).toEqual([{ label: "worker-a", type: "host.herdr", body: { action: "status" } }]);
  expect(c.out).toEqual(["RUNNER_HERDR machine=worker-a action=status state=up managed=true paused=false read; herdr up"]);
});

test("restart without --yes lists the machine's open lanes it would end and sends nothing", async () => {
  const c = cli();
  expect(await runnerHerdrMain({ action: "restart", machine: "worker-a", yes: false }, c.deps)).toBe(2);
  expect(c.out).toEqual(["RUNNER_HERDR_LANES machine=worker-a restart ends herdr and these 2 open lanes: a, c"]);
  expect(c.err[0]).toStartWith("RUNNER_HERDR_CONFIRM restart on machine=worker-a");
  expect(c.sent).toEqual([]);
});

test("stop and restart with --yes list the lanes and then send; the lead host names its lead pane and its unbound lanes", async () => {
  const c = cli({ answer: { cmdId: "x", state: "verified", detail: "stopped", result: { action: "stop", state: "down", managed: true, paused: true } } });
  expect(await runnerHerdrMain({ action: "stop", machine: "local", yes: true }, c.deps)).toBe(0);
  expect(c.out[0]).toBe("RUNNER_HERDR_LANES machine=local stop ends herdr and the lead pane and these 2 open lanes: old, lead-side");
  expect(c.out[1]).toBe("RUNNER_HERDR machine=local action=stop state=down managed=true paused=true stopped");
  expect(c.sent).toEqual([{ label: "local", type: "host.herdr", body: { action: "stop" } }]);
});

test("a proto-3 runner is refused with the upgrade command before anything is sent", async () => {
  const c = cli({ proto: 3 });
  expect(await runnerHerdrMain({ action: "start", machine: "worker-a", yes: false }, c.deps)).toBe(2);
  expect(c.err).toEqual(["RUNNER_HERDR_UNSUPPORTED machine=worker-a the runner speaks proto 3; host.herdr needs proto 4: dori runner install --machine worker-a upgrades it"]);
  expect(c.sent).toEqual([]);
  // The relay's own gate (the hub's proto, newer than this process's read) says the same.
  const gated = cli({ throws: new RunnerUnavailable("worker-a", "outdated", "host.herdr needs runner proto 4, the runner speaks 3") });
  expect(await runnerHerdrMain({ action: "start", machine: "worker-a", yes: false }, gated.deps)).toBe(2);
  expect(gated.err[0]).toStartWith("RUNNER_HERDR_UNSUPPORTED machine=worker-a");
});

test("a failed action exits 1 with the runner's detail; an unknown action is usage", async () => {
  const c = cli({ answer: { cmdId: "x", state: "failed", detail: "RUNNER_CMD_FAILED HERDR_UNMANAGED no herdr unit" } });
  expect(await runnerHerdrMain({ action: "start", machine: "worker-a", yes: false }, c.deps)).toBe(1);
  expect(c.err).toEqual(["RUNNER_HERDR_FAILED machine=worker-a action=start failed: RUNNER_CMD_FAILED HERDR_UNMANAGED no herdr unit"]);
  const u = cli();
  expect(await runnerHerdrMain({ action: "kill", machine: "worker-a", yes: false }, u.deps)).toBe(2);
  expect(u.sent).toEqual([]);
});
