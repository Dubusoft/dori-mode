import { describe, expect, test } from "bun:test";
import { checkCommand, loadPolicy, rejection, type RunnerPolicy } from "../src/runner/policy.ts";

const policy: RunnerPolicy = { agents: { omo: ["omo", "run"] }, allowedRoots: ["/data/repos"], sandbox: "required", jobs: "allow" };

// Fake filesystem: existing paths map to their real target.
const links: Record<string, string> = {
  "/data/repos": "/data/repos",
  "/data/repos/a": "/data/repos/a",
  "/data/repos-evil": "/data/repos-evil",
  "/data/repos/escape": "/etc",
  "/etc": "/etc",
};
const realpath = (p: string): string => {
  const r = links[p];
  if (r === undefined) throw new Error(`ENOENT ${p}`);
  return r;
};

const frame = (type: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ v: 1, runner: "r1", gen: 1, epoch: 1, cmdSeq: 1, type, body: { cmdId: "c1", ...body }, ...extra });
const start = (over: Record<string, unknown> = {}) =>
  frame("lane.start", {
    key: "k", briefText: "b", done: "d", thread: "t", cwd: "/data/repos/a", agentProfile: "omo", mode: "m", model: "x",
    sandbox: true, expectedLaneGen: 0, ...over,
  });
const job = (over: Record<string, unknown> = {}) =>
  frame("job.run", { opKey: "o", name: "n", command: ["ls"], cwd: "/data/repos/a", timeoutSec: 5, heavy: false, ...over });

const rule = (command: unknown, p: RunnerPolicy = policy): string | undefined => {
  const r = checkCommand(p, command, realpath);
  return r.ok ? undefined : r.rule;
};

describe("runner command policy", () => {
  test("a valid command passes", () => {
    expect(checkCommand(policy, start(), realpath).ok).toBe(true);
    expect(checkCommand(policy, job(), realpath).ok).toBe(true);
    expect(checkCommand(policy, frame("guard.kill", { keys: ["a"] }), realpath).ok).toBe(true);
  });

  test("cwd outside allowedRoots", () => {
    const r = checkCommand(policy, start({ cwd: "/data/repos-evil" }), realpath);
    expect(r.ok).toBe(false);
    expect(rejection(r)).toBe("RUNNER_CMD_REJECTED cwd-outside-roots");
  });

  test("unregistered agentProfile", () => {
    expect(rejection(checkCommand(policy, start({ agentProfile: "rogue" }), realpath))).toBe("RUNNER_CMD_REJECTED agent-profile");
  });

  test("sandbox:false under required", () => {
    expect(rejection(checkCommand(policy, start({ sandbox: false }), realpath))).toBe("RUNNER_CMD_REJECTED sandbox-required");
    expect(checkCommand({ ...policy, sandbox: "optional" }, start({ sandbox: false }), realpath).ok).toBe(true);
  });

  test("shell-string command", () => {
    expect(rejection(checkCommand(policy, job({ command: "ls; rm -rf /" }), realpath))).toBe("RUNNER_CMD_REJECTED command-not-argv");
  });

  test("unknown field", () => {
    expect(rejection(checkCommand(policy, start({ extra: 1 }), realpath))).toBe("RUNNER_CMD_REJECTED unknown-field");
    expect(rejection(checkCommand(policy, frame("guard.kill", { keys: [], force: true }), realpath))).toBe("RUNNER_CMD_REJECTED unknown-field");
  });

  test("/data/repos-evil is not under /data/repos", () => {
    expect(rule(job({ cwd: "/data/repos-evil" }))).toBe("cwd-outside-roots");
  });

  test("a symlink escaping the root is rejected via realpath", () => {
    expect(rule(job({ cwd: "/data/repos/escape" }))).toBe("cwd-outside-roots");
  });

  test("missing cwd", () => {
    expect(rule(job({ cwd: "/data/repos/none" }))).toBe("cwd-missing");
  });

  test("jobs deny", () => {
    expect(rule(job(), { ...policy, jobs: "deny" })).toBe("jobs-denied");
  });

  test("absent config file yields defaults", () => {
    const p = loadPolicy("/nonexistent-runner-dir-for-test");
    expect(p).toEqual({ agents: {}, allowedRoots: [], sandbox: "optional", jobs: "allow" });
  });
});
