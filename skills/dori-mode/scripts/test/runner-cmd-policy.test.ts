import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand, checkCwd, checkQuery, loadPolicy, parsePolicy, rejection, type RunnerPolicy } from "../src/runner/policy.ts";

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

  test("proto 3 fields of lane.start pass; an unknown field inside target is refused", () => {
    expect(checkCommand(policy, start({ keywords: "ulw", session: "s1", target: { pane: "w1:p2" }, heavySlots: 2, heavyMaxLoad: 7.5 }), realpath).ok).toBe(true);
    expect(rule(start({ target: { pane: "w1:p2", tab: "x" } }))).toBe("unknown-field");
    expect(rule(start({ heavySlots: 1.5 }))).toBe("field-type");
  });

  test("lane.adopt cwd is checked like any cwd; an absent cwd is fine", () => {
    const adopt = (over: Record<string, unknown> = {}) => frame("lane.adopt", { key: "k", pane: "w1:p2", mode: "ulw", model: "m", ...over });
    expect(checkCommand(policy, adopt(), realpath).ok).toBe(true);
    expect(checkCommand(policy, adopt({ cwd: "/data/repos/a" }), realpath).ok).toBe(true);
    expect(rule(adopt({ cwd: "/data/repos-evil" }))).toBe("cwd-outside-roots");
    expect(rule(adopt({ cwd: "relative" }))).toBe("cwd-missing");
  });

  test("checkCwd applies the same root check to an effective pane cwd: symlink escape and prefix siblings are refused", () => {
    expect(checkCwd(policy, "/data/repos/a", realpath)).toBeUndefined();
    expect(checkCwd(policy, "/data/repos/escape", realpath)).toEqual({ rule: "cwd-outside-roots", detail: "/etc" });
    expect(checkCwd(policy, "/data/repos-evil", realpath)?.rule).toBe("cwd-outside-roots");
    expect(checkCwd(policy, "/data/repos/none", realpath)?.rule).toBe("cwd-missing");
    expect(checkCwd(policy, "relative", realpath)?.rule).toBe("cwd-missing");
  });

  test("lane.git root must resolve under allowedRoots, and jobs deny refuses it", () => {
    const git = (over: Record<string, unknown> = {}) => frame("lane.git", { key: "k", op: "branch-delete", root: "/data/repos/a", branch: "lane-k", ...over });
    expect(checkCommand(policy, git(), realpath).ok).toBe(true);
    expect(rule(git({ root: "/data/repos/escape" }))).toBe("cwd-outside-roots");
    expect(rule(git({ root: "/data/repos/none" }))).toBe("cwd-missing");
    expect(rule(git({ op: "rm -rf" }))).toBe("field-type");
    expect(rule(git(), { ...policy, jobs: "deny" })).toBe("jobs-denied");
  });

  test("lane.git worktree-add path under allowedRoots passes", () => {
    const base = mkdtempSync(join(tmpdir(), "runner-cmd-policy-"));
    const root = join(base, "repos");
    mkdirSync(root);
    const p = { ...policy, allowedRoots: [root] };
    const git = frame("lane.git", { key: "k", op: "worktree-add", root, path: join(root, "worktree"), ref: "main" });
    expect(checkCommand(p, git, realpathSync).ok).toBe(true);
  });

  test("lane.git worktree-add path outside allowedRoots is refused", () => {
    const base = mkdtempSync(join(tmpdir(), "runner-cmd-policy-"));
    const root = join(base, "repos");
    mkdirSync(root);
    const git = frame("lane.git", { key: "k", op: "worktree-add", root, path: join(base, "outside"), ref: "main" });
    const r = checkCommand({ ...policy, allowedRoots: [root] }, git, realpathSync);
    expect(r.ok).toBe(false);
    expect(rejection(r)).toBe("RUNNER_CMD_REJECTED cwd-outside-roots");
  });

  test("lane.git worktree-add path escaping allowedRoots is refused", () => {
    const base = mkdtempSync(join(tmpdir(), "runner-cmd-policy-"));
    const root = join(base, "repos");
    mkdirSync(root);
    const git = frame("lane.git", { key: "k", op: "worktree-add", root, path: join(root, "..", "escape"), ref: "main" });
    const r = checkCommand({ ...policy, allowedRoots: [root] }, git, realpathSync);
    expect(r.ok).toBe(false);
    expect(rejection(r)).toBe("RUNNER_CMD_REJECTED cwd-outside-roots");
  });

  test("the other proto 3 commands validate by schema", () => {
    expect(checkCommand(policy, frame("lane.pause", { key: "k", step: "goal" }), realpath).ok).toBe(true);
    expect(rule(frame("lane.pause", { key: "k", step: "later" }))).toBe("field-type");
    expect(checkCommand(policy, frame("lane.send", { key: "k", text: "t", verify: true, mode: "guarded", refuseWhileAsking: true }), realpath).ok).toBe(true);
    expect(checkCommand(policy, frame("lane.recover", { key: "k", session: "s1" }), realpath).ok).toBe(true);
    expect(checkCommand(policy, frame("lane.notify", {
      key: "k", status: "not-done", objection: { at: "2026-11-06T00:00:00Z", reasons: ["CI red"] },
    }), realpath).ok).toBe(true);
    expect(rule(frame("lane.notify", { key: "k", status: "x", claim: { at: "t" } }))).toBe("missing-field");
  });

  test("queries: schema checked, and a q.lane.inspect with done is refused under jobs deny", () => {
    const q = (type: string, body: Record<string, unknown>) => ({ v: 1, runner: "r1", gen: 1, epoch: 1, type, body: { qid: "q1", ...body } });
    const qrule = (query: unknown, p: RunnerPolicy = policy): string | undefined => { const r = checkQuery(p, query); return r.ok ? undefined : r.rule; };
    expect(checkQuery(policy, q("q.panes", {})).ok).toBe(true);
    expect(checkQuery(policy, q("q.screen", { pane: "p", lines: 200, source: "recent" })).ok).toBe(true);
    expect(qrule(q("q.screen", { pane: "p", lines: 200, source: "all" }))).toBe("field-type");
    expect(qrule(q("q.stat", { paths: ["/a"], extra: 1 }))).toBe("unknown-field");
    const inspect = q("q.lane.inspect", { key: "k", git: true, done: "command [\"true\"]", doneCwd: "/data/repos" });
    expect(checkQuery(policy, inspect).ok).toBe(true);
    expect(qrule(inspect, { ...policy, jobs: "deny" })).toBe("jobs-denied");
    expect(checkQuery({ ...policy, jobs: "deny" }, q("q.lane.inspect", { key: "k", git: true })).ok).toBe(true);
    // A command is not a query, and a query is not a command.
    expect(qrule(frame("lane.observe", { key: "k" }))).toBe("not-a-command");
    expect(qrule({ ...q("q.panes", {}), cmdSeq: 1 })).toBe("sequence");
    expect(qrule({ v: 1, runner: "r1", gen: 1, epoch: 1, type: "ack", body: { eventAck: 1 } })).toBe("not-a-command");
    expect(rule(q("q.panes", {}))).toBe("not-a-command");
  });

  test("sandboxCheck parses as an argv; an empty, non-array or non-string one is refused", () => {
    expect(parsePolicy({ sandbox: "required", sandboxCheck: ["/h/.dori/runner/bin/lane-sandbox", "--check"] }).sandboxCheck)
      .toEqual(["/h/.dori/runner/bin/lane-sandbox", "--check"]);
    expect(parsePolicy({}).sandboxCheck).toBeUndefined();
    for (const bad of [[], [""], "lane-sandbox --check", ["lane-sandbox", 3]]) {
      expect(() => parsePolicy({ sandboxCheck: bad })).toThrow("sandboxCheck must be a non-empty string array");
    }
  });

  test("absent config file yields defaults", () => {
    const p = loadPolicy("/nonexistent-runner-dir-for-test");
    expect(p).toEqual({ agents: {}, allowedRoots: [], sandbox: "optional", jobs: "allow" });
  });
});
