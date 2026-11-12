import { expect, test } from "bun:test";
import { herdrElevatedError, herdrProcess, herdrUnitInstalled, HerdrWatch, startManagedHerdr } from "../src/runner/herdr-watch.ts";
import { hostHerdr } from "../src/runner/herdr-control.ts";
import type { RunnerEventType } from "../src/runner/protocol.ts";
import { probeHerdr } from "../src/runner/health.ts";
import type { Ran, Runner } from "../src/run.ts";

const ok = (out: string) => ({ code: 0, out, err: "" });
const bad = (code = 1) => ({ code, out: "", err: "x" });
const row = (pid: number, cmd: string, owner: string, date = "2026-11-06T10:00:00.0000000+09:00") =>
  ({ ProcessId: pid, CommandLine: cmd, CreationDate: date, Owner: owner, Domain: "HOST" });
const cim = (out: string, calls: string[][] = []): Runner => async (argv) => {
  calls.push([...argv]);
  return argv[0] === "herdr" ? bad() : ok(out);
};
const win = { platform: "win32", user: "Bob" };

test("win32 herdrProcess: empty output means not running, and the query is a CIM call", async () => {
  const calls: string[][] = [];
  expect(await herdrProcess(cim("", calls), win)).toEqual({ running: false });
  expect(calls[0]?.[0]).toBe("powershell.exe");
  expect(calls[0]?.at(-1)).toContain("Win32_Process");
  expect(calls[0]?.at(-1)).toContain("Name='herdr.exe'");
});

test("win32 herdrProcess: a single object (not an array) is read", async () => {
  const out = JSON.stringify(row(42, "C:\\herdr.exe server", "bob"));
  expect(await herdrProcess(cim(out), win)).toEqual({ running: true, instance: "42@2026-11-06T10:00:00.0000000+09:00" });
});

test("win32 herdrProcess: keeps only server command lines owned by the current user, sorted", async () => {
  const out = JSON.stringify([
    row(9, "herdr.exe server", "bob", "B"),
    row(5, "herdr.exe client", "bob"),
    row(6, "herdr.exe server", "alice"),
    row(3, "herdr.exe server", "BOB", "A"),
  ]);
  expect(await herdrProcess(cim(out), win)).toEqual({ running: true, instance: "3@A;9@B" });
  expect(await herdrProcess(cim(JSON.stringify([row(5, "herdr.exe client", "bob")])), win)).toEqual({ running: false });
});

test("win32 herdrProcess: a herdr.exe with a hidden command line (elevated) is named by herdr's socket, never read as down", async () => {
  const hidden = JSON.stringify([{ ProcessId: 9, CommandLine: null, CreationDate: "A", Owner: null, Domain: null }, row(5, "herdr.exe client", "bob")]);
  const run = (socket: string): Runner => async (argv) => ok(argv.at(-1)?.includes("status server") ? socket : hidden);
  expect(await herdrProcess(run("2026-11-09T01:10:45.4763120Z\r\n"), win)).toEqual({ running: true, instance: "socket@2026-11-09T01:10:45.4763120Z" });
  expect(await herdrProcess(run(""), win)).toEqual({ running: true });
  expect(await herdrProcess(cim(JSON.stringify([row(9, "herdr.exe server", "bob", "B"), { ProcessId: 4, CommandLine: null, CreationDate: "A" }])), win)).toEqual({ running: true, instance: "9@B" });
});

test("win32 herdrProcess: a failed or unreadable query is treated as running without an instance", async () => {
  expect(await herdrProcess(async () => bad(2), win)).toEqual({ running: true });
  expect(await herdrProcess(cim("not json"), win)).toEqual({ running: true });
  expect(await herdrProcess(cim(JSON.stringify({ ProcessId: "x" })), win)).toEqual({ running: true });
});

test("win32 probeHerdr: answering is up; a server process is hung, none down, a failed query unknown", async () => {
  expect(await probeHerdr(async () => ok(""), win)).toBe("up");
  expect(await probeHerdr(cim(JSON.stringify(row(1, "herdr.exe server", "bob"))), win)).toBe("hung");
  expect(await probeHerdr(cim(""), win)).toBe("down");
  expect(await probeHerdr(async (argv) => argv[0] === "herdr" ? bad() : bad(2), win)).toBe("unknown");
});

const ELEVATED = "herdr pane list failed: Error: PermissionDenied: Access is denied. (os error 5). For an elevated server, use an administrator terminal or set [server] allow_unelevated_clients = true";

test("win32 starts herdr server itself through WMI, outside the runner's tree, and counts as managed", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => { calls.push([...argv]); return ok("started herdr server pid 4242"); };
  expect(herdrUnitInstalled({ os: "win32", exists: () => false })).toBe(true);
  expect(await startManagedHerdr({ run, os: "win32", home: "C:\\Users\\bob", exists: () => false })).toEqual({ ok: true, detail: "started herdr server pid 4242" });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
  expect(calls[0]?.at(-1)).toContain("Invoke-CimMethod -ClassName Win32_Process -MethodName Create");
  expect(calls[0]?.at(-1)).toContain(`'"' + $h + '" server'`);
  expect(await startManagedHerdr({ run: async () => ({ code: 1, out: "Win32_Process.Create returned 9", err: "" }), os: "win32" })).toEqual({ ok: false, detail: "Win32_Process.Create returned 9" });
});

test("an elevated-server refusal is read only on win32", () => {
  expect(herdrElevatedError(ELEVATED, "win32")).toBe(true);
  expect(herdrElevatedError("herdr pane list failed: connect: No such file or directory (os error 2)", "win32")).toBe(false);
  expect(herdrElevatedError(ELEVATED, "linux")).toBe(false);
  expect(herdrElevatedError("herdr pane list failed: Permission denied (os error 13)", "darwin")).toBe(false);
});

test("win32 probeHerdr: a refusal by an elevated server is elevated, not hung", async () => {
  const run: Runner = async (argv) => argv[0] === "herdr" ? { code: 1, out: "", err: ELEVATED } : ok(JSON.stringify(row(1, "herdr.exe server", "bob")));
  expect(await probeHerdr(run, win)).toBe("elevated");
});

const watchOn = (platform: string, world: { list: Ran; running: boolean }) => {
  let at = 0;
  const events: [RunnerEventType, unknown][] = [];
  const starts: string[] = [];
  const watch = new HerdrWatch({
    run: async () => world.list, now: () => at, monotonic: () => at, platform,
    publish: (type, body) => { events.push([type, body]); },
    process: async () => ({ running: world.running }),
    start: async () => { starts.push("start"); return { ok: true, detail: "started herdr server pid 7" }; },
  });
  return { watch, events, starts, tick: async (ms: number) => { at = ms; await watch.sample(); } };
};

test("win32 watch: a pane list refused by an elevated server is elevated, never hung, and starts nothing; elsewhere the same text stays hung", async () => {
  const w = watchOn("win32", { list: { code: 1, out: "", err: ELEVATED }, running: true });
  await w.tick(0); await w.tick(30_000);
  expect(w.watch.snapshot()?.state).toBe("elevated");
  expect(w.events).toHaveLength(1);
  expect(String((w.events[0]?.[1] as { detail: string }).detail)).toContain("allow_unelevated_clients = true");
  expect(w.starts).toEqual([]);
  const l = watchOn("linux", { list: { code: 1, out: "", err: ELEVATED }, running: true });
  await l.tick(0); await l.tick(30_000);
  expect(l.watch.snapshot()?.state).toBe("hung");
});

test("win32 boot: the runner starts herdr at once when no server runs, and leaves a running, answering or paused one alone", async () => {
  const down = watchOn("win32", { list: { code: 1, out: "", err: "connect failed (os error 2)" }, running: false });
  await down.watch.boot();
  expect(down.starts).toEqual(["start"]);
  expect(down.events).toEqual([["herdr.start", { ok: true, detail: "started herdr server pid 7" }]]);
  const elevated = watchOn("win32", { list: { code: 1, out: "", err: ELEVATED }, running: true });
  await elevated.watch.boot();
  const up = watchOn("win32", { list: ok('{"result":{"panes":[]}}'), running: true });
  await up.watch.boot();
  const linux = watchOn("linux", { list: { code: 1, out: "", err: "down" }, running: false });
  await linux.watch.boot();
  expect([elevated.starts, up.starts, linux.starts]).toEqual([[], [], []]);
  const paused = new HerdrWatch({
    run: async () => bad(), now: () => 0, monotonic: () => 0, platform: "win32", paused: () => true, publish: () => {},
    process: async () => ({ running: false }), start: async () => { throw new Error("must not start"); },
  });
  await paused.boot();
});

/** A Windows host for `dori runner herdr`: the pane list answers, fails or is refused; the CIM query lists server pids. */
const winHost = (w: { list: "up" | "down" | "elevated"; pids: number[] }) => {
  const calls: string[] = [];
  const signals: string[] = [];
  const run: Runner = async (argv) => {
    const line = argv.join(" ");
    calls.push(argv[0] === "powershell.exe" ? `powershell ${argv.at(-1)?.includes("Create") ? "create" : argv.at(-1)?.includes("status server") ? "socket" : "cim"}` : line);
    if (line === "herdr pane list") return w.list === "up" ? ok('{"result":{"panes":[]}}') : { code: 1, out: "", err: w.list === "elevated" ? ELEVATED : "connect failed (os error 2)" };
    if (line === "herdr server stop") { w.pids = []; w.list = "down"; return ok(""); }
    if (argv.at(-1)?.includes("Create")) { w.pids = [900]; w.list = "up"; return ok("started herdr server pid 900"); }
    if (argv.at(-1)?.includes("status server")) return ok("");
    return ok(JSON.stringify(w.pids.map((p) => row(p, "C:\\herdr.exe server", "bob", `D${p}`))));
  };
  let at = 0;
  const control = hostHerdr({
    run, runnerDir: "C:\\runner", os: "win32", home: "C:\\Users\\bob", user: "bob", exists: () => false, setPaused: () => {},
    now: () => at, sleep: async (ms) => { at += ms; }, signal: (pid, sig) => { signals.push(`${sig} ${pid}`); },
  });
  return { w, calls, signals, control };
};

test("win32 dori runner herdr: start and restart run the runner's own server instead of refusing as unmanaged", async () => {
  const down = winHost({ list: "down", pids: [] });
  const started = await down.control("start");
  expect(started.result).toMatchObject({ action: "start", state: "up", instance: "900@D900", managed: true });
  expect(started.detail).toContain("server started");
  const up = winHost({ list: "up", pids: [77] });
  const restarted = await up.control("restart");
  expect(up.calls.indexOf("herdr server stop")).toBeLessThan(up.calls.indexOf("powershell create"));
  expect(up.signals).toEqual([]);
  expect(restarted.result).toMatchObject({ action: "restart", state: "up", instance: "900@D900", managed: true });
});

test("win32 dori runner herdr: an elevated server is refused with HERDR_ELEVATED before anything is ended or started", async () => {
  for (const action of ["start", "restart", "stop"] as const) {
    const h = winHost({ list: "elevated", pids: [] });
    await expect(h.control(action)).rejects.toThrow("HERDR_ELEVATED");
    expect(h.calls.filter((c) => c === "herdr server stop" || c === "powershell create")).toEqual([]);
    expect(h.signals).toEqual([]);
  }
  const status = await winHost({ list: "elevated", pids: [] }).control("status");
  expect(status.result).toMatchObject({ state: "elevated", managed: true });
});
