import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { watchConfigFiles } from "../src/config-watch.ts";
import { runnerPolicy } from "../src/runner/local-policy.ts";
import { checkCommand, POLICY_FILE } from "../src/runner/policy.ts";
import { type PolicyReload, policyReloader } from "../src/runner/policy-reload.ts";
import { validateFrame, type RunnerEventBodies } from "../src/runner/protocol.ts";
import { workspaceReport } from "../src/runner/workspaces.ts";
import { defaultConfig } from "../src/config.ts";

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "policy-reload-")));
  dirs.push(root);
  const runnerDir = join(root, "runner");
  const a = join(root, "a");
  const b = join(root, "b");
  for (const dir of [runnerDir, a, b]) mkdirSync(dir);
  const file = join(runnerDir, POLICY_FILE);
  const write = (value: unknown): void => { writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); };
  write({ agents: { default: ["omo"] }, allowedRoots: [a], detectWorkspaces: false });
  const cfg = defaultConfig(root);
  const policy = structuredClone(runnerPolicy(runnerDir, true, cfg));
  const published: RunnerEventBodies["runner.config"][] = [];
  const logs: string[] = [];
  const applied: string[] = [];
  const reload = policyReloader({
    policy, load: async () => ({ policy: runnerPolicy(runnerDir, true, cfg) }),
    applied: (before, after) => { applied.push(`${before.allowedRoots.length}->${after.allowedRoots.length}`); },
    publish: (body) => { published.push(body); }, log: (line) => { logs.push(line); },
  });
  let next = Promise.withResolvers<PolicyReload>();
  stops.push(watchConfigFiles([file], async () => { next.resolve(await reload()); }, { debounceMs: 10, pollMs: 60_000 }));
  const edited = async (value: unknown): Promise<PolicyReload> => {
    next = Promise.withResolvers<PolicyReload>();
    write(value);
    return next.promise;
  };
  const start = (cwd?: string) => ({
    v: 1, runner: "r1", gen: 1, epoch: 1, cmdSeq: 1, type: "lane.start",
    body: {
      cmdId: "c1", key: "k", briefText: "b", done: "d", thread: "t", agentProfile: "default", mode: "m", model: "x",
      sandbox: false, expectedLaneGen: 0, ...(cwd ? { cwd } : {}),
    },
  });
  return { root, a, b, policy, published, logs, applied, edited, start };
};

test("a running runner takes an edited runner-config.json live: new roots, defaultCwd and workspaces apply to the next command", async () => {
  const f = fixture();
  expect(checkCommand(f.policy, f.start(f.b), realpathSync, f.root)).toMatchObject({ ok: false, rule: "cwd-outside-roots" });
  expect(workspaceReport(f.policy, { realpath: realpathSync, log: () => {} }).workspaces).toEqual([]);
  const result = await f.edited({
    agents: { default: ["omo"] }, allowedRoots: [f.a, f.b], defaultCwd: f.b, workspaces: { "acme/app": f.b }, detectWorkspaces: false,
  });
  expect(result).toBe("reloaded");
  const checked = checkCommand(f.policy, f.start(), realpathSync, f.root);
  expect(checked.ok).toBe(true);
  expect(checked.ok ? (checked.command.body as { cwd?: string }).cwd : undefined).toBe(f.b);
  expect(workspaceReport(f.policy, { realpath: realpathSync, log: () => {} }).workspaces).toEqual([{ repo: "acme/app", path: f.b }]);
  expect(f.applied).toEqual(["1->2"]);
  expect(f.published).toEqual([{ state: "reloaded", detail: "allowedRoots, defaultCwd, workspaces" }]);
  expect(f.logs).toEqual(["RUNNER_CONFIG_RELOADED allowedRoots, defaultCwd, workspaces"]);
});

test("an invalid runner-config.json edit keeps the last good policy and warns the supervisor", async () => {
  const f = fixture();
  const before = structuredClone(f.policy);
  expect(await f.edited('{ "allowedRoots": [')).toBe("invalid");
  expect(await f.edited({ agents: { default: ["omo"] }, allowedRoots: [f.b], sandbx: "required" })).toBe("invalid");
  expect(f.policy).toEqual(before);
  expect(checkCommand(f.policy, f.start(f.a), realpathSync, f.root).ok).toBe(true);
  expect(f.published.map((body) => body.state)).toEqual(["invalid", "invalid"]);
  expect(f.published[1]?.detail).toBe("runner-config: unknown key sandbx; the runner keeps its last good policy");
  expect(f.logs.every((line) => line.startsWith("RUNNER_CONFIG_INVALID "))).toBe(true);
  expect(f.applied).toEqual([]);
});

test("runner.config is a valid runner event for the supervisor", () => {
  const frame = { v: 1, runner: "r1", gen: 1, epoch: 1, seq: 3, type: "runner.config", body: { state: "invalid", detail: "x" } };
  expect(validateFrame(frame, "runner").type).toBe("runner.config");
  expect(() => validateFrame({ ...frame, body: { state: "broken", detail: "x" } }, "runner")).toThrow();
});
