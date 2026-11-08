import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRunnerEndpoints, runnerListenAddress, RUNNER_ENDPOINTS_FILE, writeRunnerEndpoint } from "../src/runner/endpoints.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

test("endpoint discovery is a private label map separate from config, preserving other entries", () => {
  const state = withState();
  cleanups.push(state.done);
  expect(readRunnerEndpoints(state.dir)).toEqual({});
  writeRunnerEndpoint(state.dir, "a", "100.101.1.2:7411");
  writeRunnerEndpoint(state.dir, "b", "[fd12::1]:7411");
  writeRunnerEndpoint(state.dir, "a", "10.1.2.3:7411");
  const path = join(state.dir, RUNNER_ENDPOINTS_FILE);
  expect(readRunnerEndpoints(state.dir)).toEqual({ a: "10.1.2.3:7411", b: "[fd12::1]:7411" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(readRunnerEndpoints(state.dir));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(() => writeRunnerEndpoint(state.dir, "public", "8.8.8.8:7411")).toThrow("RUNNER_LISTEN_REFUSED");
  writeFileSync(path, '{"worker":"0.0.0.0:7411"}');
  expect(() => readRunnerEndpoints(state.dir)).toThrow("RUNNER_ENDPOINTS_INVALID");
});

test("SSH targets yield a private IP with the runner port, and hostname resolution is injected", async () => {
  const names: string[] = [];
  const resolve = async (host: string) => { names.push(host); return "100.101.1.2"; };
  expect(await runnerListenAddress("user@worker:2222", resolve)).toBe("100.101.1.2:7411");
  expect(names).toEqual(["worker"]);
  expect(await runnerListenAddress("user@10.1.2.3:2222", resolve)).toBe("10.1.2.3:7411");
  expect(await runnerListenAddress("user@[fd12::1]:2222", resolve)).toBe("[fd12::1]:7411");
  expect(await runnerListenAddress("::1", resolve)).toBe("[::1]:7411");
  expect(names).toEqual(["worker"]);
  await expect(runnerListenAddress("worker", async () => "8.8.8.8")).rejects.toThrow("RUNNER_LISTEN_REFUSED");
  await expect(runnerListenAddress("0.0.0.0", resolve)).rejects.toThrow("RUNNER_LISTEN_REFUSED");
  await expect(runnerListenAddress("worker", async () => { throw new Error("no address"); })).rejects.toThrow("RUNNER_LISTEN_RESOLVE_FAILED");
});
