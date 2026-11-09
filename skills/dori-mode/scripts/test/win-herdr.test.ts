import { expect, test } from "bun:test";
import { herdrProcess, startManagedHerdr } from "../src/runner/herdr-watch.ts";
import { probeHerdr } from "../src/runner/health.ts";
import type { Runner } from "../src/run.ts";

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

test("win32 never starts herdr", async () => {
  expect(await startManagedHerdr({ run: async () => ok(""), os: "win32", home: "C:\\Users\\bob", exists: () => true })).toBeUndefined();
});
