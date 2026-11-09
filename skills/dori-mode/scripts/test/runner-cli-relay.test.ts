import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryFailed, RunnerUnavailable } from "../src/runner/call.ts";
import type { RunnerCall, Timers } from "../src/runner/call.ts";
import { CLI_SOCKET, cliRunnerCall, cliSocketPath, serveCliRelay } from "../src/runner/cli-relay.ts";
import { memoryNetwork } from "../src/runner/transport.ts";
import type { Connector, Listener, Transport } from "../src/runner/transport.ts";
import { listenUnix } from "../src/runner/unix-transport.ts";

/** A memory network whose lines are delivered by a microtask after each send, so awaiting a request needs no manual pump. */
const autoNetwork = () => {
  const net = memoryNetwork();
  const flush = () => queueMicrotask(() => { for (const p of net.pairs) p.pump(); });
  const wrap = (t: Transport): Transport => ({
    send: (line) => { t.send(line); flush(); },
    onLine: (h) => t.onLine(h), onClose: (h) => t.onClose(h), close: (r) => t.close(r),
    get open() { return t.open; },
  });
  const listener: Listener = {
    onConnection: (h) => net.listener.onConnection((t) => h(wrap(t))),
    close: () => net.listener.close(),
  };
  const connect: Connector = async () => wrap(await net.connect());
  return { listener, connect };
};

const fakeCalls = (): RunnerCall & { seen: unknown[] } => {
  const seen: unknown[] = [];
  return {
    seen,
    connected: (label) => label === "local",
    call: (async (label: string, type: string, body: unknown, opts: unknown) => {
      seen.push({ label, type, body, opts });
      if (label === "gone") throw new RunnerUnavailable(label, "disconnected", "no admitted connection");
      return { cmdId: "c1", state: "verified", detail: "ok", result: { closed: "tab", gone: true } };
    }) as never,
    query: (async (label: string, type: string, body: unknown) => {
      seen.push({ label, type, body });
      if (label === "gone") throw new RunnerUnavailable(label, "outdated", "needs proto 3");
      if (type === "q.stat") throw new QueryFailed(label, "stat failed");
      return { panes: [] };
    }) as never,
  };
};

describe("CLI relay over an in-memory listener/connector", () => {
  test("round-trips a query", async () => {
    const net = autoNetwork();
    const calls = fakeCalls();
    const logs: string[] = [];
    const stop = serveCliRelay(net.listener, calls, (l) => logs.push(l));
    const client = cliRunnerCall("unused", { connect: net.connect });
    expect(await client.query("local", "q.panes", {})).toEqual({ panes: [] });
    expect(calls.seen).toEqual([{ label: "local", type: "q.panes", body: {} }]);
    stop();
  });

  test("round-trips a call with its options and a structured result", async () => {
    const net = autoNetwork();
    const calls = fakeCalls();
    const stop = serveCliRelay(net.listener, calls, () => {});
    const client = cliRunnerCall("unused", { connect: net.connect });
    const r = await client.call("local", "lane.close", { key: "a", worktreeChecks: false }, { cmdId: "op:1", timeoutMs: 5000 });
    expect(r).toEqual({ cmdId: "c1", state: "verified", detail: "ok", result: { closed: "tab", gone: true } });
    expect(calls.seen[0]).toEqual({ label: "local", type: "lane.close", body: { key: "a", worktreeChecks: false }, opts: { cmdId: "op:1", timeoutMs: 5000 } });
    stop();
  });

  test("RunnerUnavailable and QueryFailed cross the relay with their kind; connected is relayed", async () => {
    const net = autoNetwork();
    const logs: string[] = [];
    const stop = serveCliRelay(net.listener, fakeCalls(), (l) => logs.push(l));
    const client = cliRunnerCall("unused", { connect: net.connect });
    const a = await client.call("gone", "lane.stop", { key: "a" }).catch((e) => e);
    expect(a).toBeInstanceOf(RunnerUnavailable);
    expect(a.label).toBe("gone");
    expect(a.why).toBe("disconnected");
    const b = await client.query("gone", "q.panes", {}).catch((e) => e);
    expect(b.why).toBe("outdated");
    const c = await client.query("local", "q.stat", { paths: ["/x"] }).catch((e) => e);
    expect(c).toBeInstanceOf(QueryFailed);
    expect(c.message).toBe("stat failed");
    expect(client.connected("local")).toBe(false);
    expect(await client.refresh("local")).toBe(true);
    expect(client.connected("local")).toBe(true);
    expect(await client.refresh("gone")).toBe(false);
    expect(logs.length).toBe(3);
    stop();
  });

  test("a malformed request line is answered, not dropped", async () => {
    const net = autoNetwork();
    serveCliRelay(net.listener, fakeCalls(), () => {});
    const t = await net.connect();
    const got = new Promise<string>((resolve) => t.onLine(resolve));
    t.send("not json\n");
    expect(JSON.parse(await got)).toMatchObject({ ok: false, code: "LANE_OP_FAILED" });
  });

  test("an unreachable socket throws RunnerUnavailable disconnected with the supervisor hint", async () => {
    const client = cliRunnerCall("unused", { connect: async () => { throw new Error("ENOENT"); } });
    const err = await client.query("local", "q.panes", {}).catch((e) => e);
    expect(err).toBeInstanceOf(RunnerUnavailable);
    expect(err.why).toBe("disconnected");
    expect(err.message).toContain("systemctl --user start dori-supervisor.service");
  });

  test("a relay that closes after the request was sent is lost, not disconnected", async () => {
    let closed: (() => void) | undefined;
    const transport = {
      send: () => { queueMicrotask(() => closed?.()); },
      onLine: () => {}, onClose: (h: () => void) => { closed = h; }, close: () => {},
      get open() { return true; },
    } as unknown as Transport;
    const client = cliRunnerCall("unused", { connect: async () => transport });
    const err = await client.call("local", "lane.close", { key: "a", worktreeChecks: false }).catch((e) => e);
    expect(err).toBeInstanceOf(RunnerUnavailable);
    expect(err.why).toBe("lost");
  });

  test("a relay that never answers times out on the injected timer", async () => {
    const net = memoryNetwork();
    const fired: (() => void)[] = [];
    const timers: Timers = { set: (fn) => { fired.push(fn); return fn; }, clear: () => {} };
    const client = cliRunnerCall("unused", { connect: net.connect, timers });
    const p = client.query("local", "q.panes", {}).catch((e) => e);
    await net.connect;
    await Promise.resolve();
    await Promise.resolve();
    fired[0]!();
    expect((await p).why).toBe("timeout");
  });
});

describe("CLI relay over a real unix socket", () => {
  test("cliSocketPath is <runnerDir>/sock/cli and a query round-trips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-"));
    try {
      expect(cliSocketPath(dir)).toBe(join(dir, "sock", CLI_SOCKET));
      mkdirSync(join(dir, "sock"), { mode: 0o700 });
      const listener = listenUnix(cliSocketPath(dir));
      const stop = serveCliRelay(listener, fakeCalls(), () => {});
      const client = cliRunnerCall(cliSocketPath(dir));
      expect(await client.query("local", "q.panes", {})).toEqual({ panes: [] });
      stop();
      listener.close();
      const err = await client.query("local", "q.panes", {}).catch((e) => e);
      expect(err.why).toBe("disconnected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
