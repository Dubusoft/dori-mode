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

  test("a cwd lexically outside every root is refused without any realpath call on it (TCC folders block realpath)", () => {
    const seen: string[] = [];
    const recording = (p: string): string => { seen.push(p); return realpath(p); };
    const outside = "/Users/hsnam/Documents";
    expect(checkCwd(policy, outside, recording)).toEqual({ rule: "cwd-outside-roots", detail: outside });
    expect(checkCwd(policy, "/data/repos/../repos-evil/x", recording)).toEqual({ rule: "cwd-outside-roots", detail: "/data/repos-evil/x" });
    const r = checkCommand(policy, start({ cwd: outside }), recording);
    expect(r.ok ? undefined : [r.rule, r.detail]).toEqual(["cwd-outside-roots", outside]);
    expect(rule(job({ cwd: outside }))).toBe("cwd-outside-roots");
    expect(seen.filter((p) => p.startsWith("/Users") || p.includes("repos-evil"))).toEqual([]);
    // Even a throwing stub is never reached for the path (only roots may be resolved).
    const guarded = (p: string): string => { if (!p.startsWith("/data/repos")) throw new Error(`realpath touched ${p}`); return realpath(p); };
    expect(checkCwd(policy, outside, guarded)?.rule).toBe("cwd-outside-roots");
  });

  test("a cwd inside a root still resolves, and a symlink escaping the root is still refused after the lexical pre-check", () => {
    expect(checkCwd(policy, "/data/repos/a", realpath)).toBeUndefined();
    expect(checkCwd(policy, "/data/repos/escape", (p) => { if (p === "/data/repos/escape") return "/data/repos/a"; return realpath(p); })).toBeUndefined();
    expect(checkCwd(policy, "/data/repos/escape", realpath)).toEqual({ rule: "cwd-outside-roots", detail: "/etc" });
  });

  test("a root given in symlinked form admits a cwd given in either its symlinked or resolved form", () => {
    const fs: Record<string, string> = { "/var/tmp/root": "/private/var/tmp/root", "/private/var/tmp/root": "/private/var/tmp/root", "/private/var/tmp/root/w": "/private/var/tmp/root/w", "/var/tmp/root/w": "/private/var/tmp/root/w" };
    const rp = (p: string): string => { const r = fs[p]; if (r === undefined) throw new Error(`ENOENT ${p}`); return r; };
    const linked: RunnerPolicy = { ...policy, allowedRoots: ["/var/tmp/root"] };
    expect(checkCwd(linked, "/private/var/tmp/root/w", rp)).toBeUndefined();
    expect(checkCwd(linked, "/var/tmp/root/w", rp)).toBeUndefined();
    expect(checkCwd(linked, "/private/var/other", rp)?.rule).toBe("cwd-outside-roots");
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

  test("defaultCwd parses absolute or ~-relative (expanded to the runner's home); anything else is refused", () => {
    expect(parsePolicy({ defaultCwd: "~/work" }, "/Users/me").defaultCwd).toBe("/Users/me/work");
    expect(parsePolicy({ defaultCwd: "~" }, "/Users/me").defaultCwd).toBe("/Users/me");
    expect(parsePolicy({ defaultCwd: "/data/repos/a" }).defaultCwd).toBe("/data/repos/a");
    expect(parsePolicy({})).not.toHaveProperty("defaultCwd");
    for (const bad of ["work", "~other/x", "", 3, ["/a"]]) {
      expect(() => parsePolicy({ defaultCwd: bad }, "/Users/me")).toThrow("runner-config: defaultCwd must be an absolute path or start with ~/");
    }
  });

  test("a lane.start without cwd gets defaultCwd, else home, and that directory is checked against allowedRoots", () => {
    const { cwd: _, ...noCwd } = start().body as Record<string, unknown>;
    const bare = { ...start(), body: noCwd };
    const filled = (p: RunnerPolicy, home: string) => { const r = checkCommand(p, bare, realpath, home); return r.ok ? (r.command.body as { cwd?: string }).cwd : r.rule; };
    expect(filled({ ...policy, defaultCwd: "/data/repos/a" }, "/etc")).toBe("/data/repos/a");
    expect(filled(policy, "/data/repos")).toBe("/data/repos");
    const outside = checkCommand({ ...policy, defaultCwd: "/etc" }, bare, realpath, "/data/repos");
    expect(rejection(outside)).toBe("RUNNER_CMD_REJECTED cwd-outside-roots");
    expect(filled(policy, "/etc")).toBe("cwd-outside-roots");
    // An explicit cwd is never replaced.
    expect(checkCommand({ ...policy, defaultCwd: "/data/repos" }, start(), realpath, "/data/repos")).toMatchObject({ ok: true, command: { body: { cwd: "/data/repos/a" } } });
  });

  test("reposRoot and the effective worktree root are added to allowedRoots after the explicit ones", () => {
    const agents = { omo: ["omo", "run"] };
    expect(parsePolicy({ agents, allowedRoots: ["/home/u"], reposRoot: "/data/repos" }).allowedRoots).toEqual(["/home/u", "/data/repos", "/data/repos/worktrees"]);
    expect(parsePolicy({ agents, allowedRoots: ["/home/u", "/data/repos"], reposRoot: "/data/repos", worktreeRoot: "/srv/wt" }).allowedRoots)
      .toEqual(["/home/u", "/data/repos", "/srv/wt"]);
    expect(parsePolicy({ agents, allowedRoots: ["/home/u"] }).allowedRoots).toEqual(["/home/u"]);
  });

  test("a lane.start under reposRoot passes without listing it in allowedRoots; outside every root it is still refused", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "runner-cmd-policy-")));
    const reposRoot = join(base, "repos");
    const cwd = join(reposRoot, "a");
    const outside = join(base, "outside");
    for (const dir of [reposRoot, cwd, outside]) mkdirSync(dir, { recursive: true });
    const p = parsePolicy({ agents: { omo: ["omo", "run"] }, allowedRoots: ["/home/u"], reposRoot });
    expect(checkCommand(p, start({ cwd }), realpathSync).ok).toBe(true);
    expect(rejection(checkCommand(p, start({ cwd: outside }), realpathSync))).toBe("RUNNER_CMD_REJECTED cwd-outside-roots");
  });

  test("absent config file yields defaults", () => {
    const p = loadPolicy("/nonexistent-runner-dir-for-test");
    expect(p).toEqual({ agents: {}, allowedRoots: [], sandbox: "optional", jobs: "allow" });
  });
});
