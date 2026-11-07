import { expect, test } from "bun:test";

import { makeRunner, RUN_TIMEOUT_CODE, type RunChild, type RunSpawnOptions } from "../src/run.ts";

/** A child that never exits on its own; its pipes close when `close` is called. */
const hungChild = (pid: number) => {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const stream = () => new ReadableStream<Uint8Array>({ start: (c) => { controllers.push(c); } });
  const child: RunChild = { pid, exited: new Promise<number>(() => {}), stdout: stream(), stderr: stream() };
  return { child, close: () => { for (const c of controllers) c.close(); } };
};

const doneChild = (pid: number, code: number, out: string): RunChild => ({
  pid, exited: Promise.resolve(code),
  stdout: new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(new TextEncoder().encode(out)); c.close(); } }),
  stderr: new ReadableStream<Uint8Array>({ start: (c) => { c.close(); } }),
});

test("on win32 a command is spawned hidden and not detached", async () => {
  const spawned: { argv: string[]; options: RunSpawnOptions }[] = [];
  const run = makeRunner({ os: "win32", spawn: (argv, options) => { spawned.push({ argv, options }); return doneChild(9, 0, "hi\n"); } });
  expect(await run(["herdr", "workspace", "list"], { cwd: "C:\\work", timeoutMs: 0 })).toEqual({ code: 0, out: "hi", err: "" });
  expect(spawned).toHaveLength(1);
  expect(spawned[0]?.argv).toEqual(["herdr", "workspace", "list"]);
  expect(spawned[0]?.options).toEqual({ windowsHide: true, stdout: "pipe", stderr: "pipe", cwd: "C:\\work" });
});

test("POSIX keeps the detached spawn", async () => {
  const options: RunSpawnOptions[] = [];
  const run = makeRunner({ os: "linux", spawn: (_argv, o) => { options.push(o); return doneChild(9, 0, ""); } });
  await run(["true"], { timeoutMs: 0, stdin: "x" });
  expect(options[0]?.detached).toBe(true);
  expect(options[0]?.windowsHide).toBeUndefined();
  expect(options[0]?.stdin).toBeInstanceOf(Blob);
});

test("on win32 a timeout runs taskkill /T /F on the command's tree and reports code 124", async () => {
  const hung = hungChild(4242);
  const spawned: { argv: string[]; options: RunSpawnOptions }[] = [];
  const run = makeRunner({
    os: "win32",
    spawn: (argv, options) => {
      spawned.push({ argv, options });
      if (argv[0] !== "taskkill") return hung.child;
      hung.close();
      return { pid: 1, exited: Promise.resolve(0) };
    },
  });
  const result = await run(["agent.exe", "--loop"], { timeoutMs: 1 });
  expect(result).toEqual({ code: RUN_TIMEOUT_CODE, out: "", err: "timed out after 1 ms: agent.exe --loop", timedOut: true });
  expect(spawned.map((s) => s.argv)).toEqual([["agent.exe", "--loop"], ["taskkill", "/PID", "4242", "/T", "/F"]]);
  expect(spawned[1]?.options).toEqual({ windowsHide: true, stdout: "ignore", stderr: "ignore" });
});

test("on win32 a timed-out command already gone (taskkill 128) is still a timeout; another taskkill failure throws", async () => {
  const gone = hungChild(7);
  const goneRun = makeRunner({ os: "win32", spawn: (argv) => {
    if (argv[0] !== "taskkill") return gone.child;
    gone.close();
    return { pid: 1, exited: Promise.resolve(128) };
  } });
  expect((await goneRun(["x"], { timeoutMs: 1 })).timedOut).toBe(true);
  const denied = hungChild(8);
  const deniedRun = makeRunner({ os: "win32", spawn: (argv) => {
    if (argv[0] !== "taskkill") return denied.child;
    denied.close();
    return { pid: 1, exited: Promise.resolve(1) };
  } });
  await expect(deniedRun(["x"], { timeoutMs: 1 })).rejects.toThrow("taskkill /T /F of pid 8 failed with code 1");
});
