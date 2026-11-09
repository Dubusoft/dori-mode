import { describe, expect, test } from "bun:test";
import type { Ran, RunOptions, Runner } from "../src/run.ts";
import { capBytes, jobRunEffect, waitCheckEffect } from "../src/runner/jobs.ts";

const published: { type: string; body: unknown }[] = [];
const publish = (type: string, body: unknown): void => { published.push({ type, body }); };
const fake = (ran: Ran | Error, seen: { argv?: readonly string[]; opts?: RunOptions } = {}): Runner => async (argv, opts) => {
  seen.argv = argv; seen.opts = opts;
  if (ran instanceof Error) throw ran;
  return ran;
};
const waitCmd = (signal: string) => ({ v: 1, runner: "r1", gen: 1, epoch: 1, cmdSeq: 1, type: "wait.check", body: { cmdId: "c1", waitId: "w1", signal, cwd: "/data/repos/a" } }) as never;
const jobCmd = (over: Record<string, unknown> = {}) =>
  ({ v: 1, runner: "r1", gen: 1, epoch: 1, cmdSeq: 2, type: "job.run", body: { cmdId: "c2", opKey: "op1", name: "n", command: ["ls", "-l"], cwd: "/data/repos/a", timeoutSec: 7, heavy: false, ...over } }) as never;

describe("runner wait.check", () => {
  test("met publishes WAIT_DONE and returns met:true", async () => {
    published.length = 0;
    const seen: { argv?: readonly string[]; opts?: RunOptions } = {};
    const out = await waitCheckEffect({ run: fake({ code: 0, out: "ok", err: "" }, seen), publish: publish as never })(waitCmd('command ["true"]'));
    expect(out.result).toEqual({ met: true });
    expect(out.detail).toBe("met");
    expect(seen.opts?.cwd).toBe("/data/repos/a");
    expect(seen.opts?.timeoutMs).toBe(10_000);
    expect(published).toHaveLength(1);
    expect(published[0]?.type).toBe("wait.result");
    expect(published[0]?.body).toMatchObject({ waitId: "w1", outcome: "WAIT_DONE" });
  });

  test("unmet publishes nothing and returns met:false", async () => {
    published.length = 0;
    const out = await waitCheckEffect({ run: fake({ code: 1, out: "", err: "" }), publish: publish as never })(waitCmd('command ["false"]'));
    expect(out.result.met).toBe(false);
    expect(out.result.error).toBeUndefined();
    expect(out.detail).toBe("unmet");
    expect(published).toHaveLength(0);
  });

  test("a run error returns error and publishes nothing", async () => {
    published.length = 0;
    const out = await waitCheckEffect({ run: fake(new Error("boom")), publish: publish as never })(waitCmd('command ["true"]'));
    expect(out.result.met).toBe(false);
    expect(typeof out.result.error).toBe("string");
    expect(out.detail).toBe(`error: ${out.result.error}`);
    expect(published).toHaveLength(0);
  });
});

describe("runner job.run", () => {
  test("exit 0 publishes verified", async () => {
    published.length = 0;
    const seen: { argv?: readonly string[]; opts?: RunOptions } = {};
    const out = await jobRunEffect({ run: fake({ code: 0, out: "fine", err: "" }, seen), publish: publish as never })(jobCmd());
    expect(seen.argv).toEqual(["ls", "-l"]);
    expect(seen.opts).toEqual({ cwd: "/data/repos/a", timeoutMs: 7000 });
    expect(out).toEqual({ detail: "exit 0", result: { exitCode: 0, timedOut: false, output: "fine", err: "" } });
    expect(published).toEqual([{ type: "job.result", body: { opKey: "op1", state: "verified", exitCode: 0, output: "fine" } }]);
  });

  test("exit 3 publishes failed and caps output and err by bytes", async () => {
    published.length = 0;
    const big = "é".repeat(40_000); // 80000 bytes
    const out = await jobRunEffect({ run: fake({ code: 3, out: big, err: "x".repeat(9000), timedOut: true }), publish: publish as never })(jobCmd());
    expect(out.detail).toBe("exit 3 (timed out)");
    expect(out.result.timedOut).toBe(true);
    expect(Buffer.byteLength(out.result.output)).toBeLessThanOrEqual(65_536);
    expect(out.result.output).toBe("é".repeat(32_768));
    expect(out.result.err).toHaveLength(4096);
    expect(published[0]?.body).toMatchObject({ state: "failed", exitCode: 3, output: out.result.output });
  });

  test("heavy:true rejects without running", async () => {
    published.length = 0;
    let ran = false;
    const run: Runner = async () => { ran = true; return { code: 0, out: "", err: "" }; };
    await expect(jobRunEffect({ run, publish: publish as never })(jobCmd({ heavy: true }))).rejects.toThrow("heavy jobs are not supported on a runner yet");
    expect(ran).toBe(false);
    expect(published).toHaveLength(0);
  });
});

test("capBytes cuts on a character boundary", () => {
  expect(capBytes("a€b", 3)).toBe("a");
  expect(capBytes("a€b", 4)).toBe("a€");
  expect(capBytes("abc", 10)).toBe("abc");
});
