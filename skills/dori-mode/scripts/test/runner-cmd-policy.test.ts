import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand, checkCwd, checkQuery, loadPolicy, parsePolicy, rejection, resolveGrants, type RunnerPolicy } from "../src/runner/policy.ts";

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

  test("a retired defaultCwd is ignored with one RUNNER_CONFIG_KEY_IGNORED warning, whatever its value", () => {
    for (const value of ["~/work", "relative", 3]) {
      const warnings: string[] = [];
      const p = parsePolicy({ agents: { omo: ["omo"] }, defaultCwd: value }, "/Users/me", "/tmp", { warn: (line) => { warnings.push(line); } });
      expect(p).not.toHaveProperty("defaultCwd");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toStartWith("RUNNER_CONFIG_KEY_IGNORED defaultCwd: ");
    }
    const warnings: string[] = [];
    parsePolicy({ agents: { omo: ["omo"] } }, "/Users/me", "/tmp", { warn: (line) => { warnings.push(line); } });
    expect(warnings).toEqual([]);
    expect(() => parsePolicy({ defaultCwdd: "/x" })).toThrow("runner-config: unknown key defaultCwdd");
  });

  test("loadPolicy loads a file that still holds defaultCwd and warns once", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "runner-cmd-policy-")));
    writeFileSync(join(dir, "runner-config.json"), JSON.stringify({ agents: { omo: ["omo"] }, allowedRoots: ["/srv"], defaultCwd: "~/work" }));
    const warnings: string[] = [];
    const p = loadPolicy(dir, (line) => { warnings.push(line); });
    expect(p.agents).toEqual({ omo: ["omo"] });
    expect(p.allowedRoots).toEqual(["/srv", join(dir, "lanes")]);
    expect(warnings).toHaveLength(1);
  });

  test("a lane.start without cwd gets <runnerDir>/lanes/<key>, checked against allowedRoots before it exists", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "runner-cmd-policy-")));
    const [home, tmp] = [join(base, "home"), join(base, "tmp")];
    const runnerDir = join(home, ".dori", "runner");
    const reposRoot = join(home, "repos");
    for (const dir of [join(runnerDir, "lanes"), reposRoot, tmp]) mkdirSync(dir, { recursive: true });
    const p = parsePolicy({ agents: { omo: ["omo", "run"] }, reposRoot }, home, tmp);
    expect(p.allowedRoots).toContain(join(runnerDir, "lanes"));
    const { cwd: _, ...noCwd } = start().body as Record<string, unknown>;
    const bare = (key: string) => ({ ...start(), body: { ...noCwd, key } });
    expect(checkCommand(p, bare("lane-a"), realpathSync, runnerDir)).toMatchObject({ ok: true, command: { body: { cwd: join(runnerDir, "lanes", "lane-a") } } });
    // A key that is no directory name is refused; a symlink planted as the lane's directory cannot leave the roots.
    expect(checkCommand(p, bare("../x"), realpathSync, runnerDir)).toMatchObject({ ok: false, rule: "cwd-missing" });
    symlinkSync(home, join(runnerDir, "lanes", "lane-evil"));
    expect(rejection(checkCommand(p, bare("lane-evil"), realpathSync, runnerDir))).toBe("RUNNER_CMD_REJECTED cwd-outside-roots");
    // An explicit cwd is never replaced.
    expect(checkCommand(p, start({ cwd: reposRoot }), realpathSync, runnerDir)).toMatchObject({ ok: true, command: { body: { cwd: reposRoot } } });
  });

  test("reposRoot and the effective worktree root are added to allowedRoots after the explicit ones", () => {
    const agents = { omo: ["omo", "run"] };
    expect(parsePolicy({ agents, allowedRoots: ["/home/u"], reposRoot: "/data/repos" }, "/home/u").allowedRoots).toEqual(["/home/u", "/data/repos", "/data/repos/worktrees"]);
    expect(parsePolicy({ agents, allowedRoots: ["/home/u", "/data/repos"], reposRoot: "/data/repos", worktreeRoot: "/srv/wt" }, "/home/u").allowedRoots)
      .toEqual(["/home/u", "/data/repos", "/srv/wt"]);
    expect(parsePolicy({ agents, allowedRoots: ["/home/u"] }, "/home/u").allowedRoots).toEqual(["/home/u"]);
    // The lanes directory joins a list that does not already hold it.
    expect(parsePolicy({ agents, allowedRoots: ["/srv"] }, "/home/u").allowedRoots).toEqual(["/srv", "/home/u/.dori/runner/lanes"]);
    // The same directory spelled with a trailing slash or through ~ is not added twice.
    expect(parsePolicy({ agents, allowedRoots: ["/home/u/repos/", "/home/u/wt"], reposRoot: "~/repos", worktreeRoot: "/home/u/wt/" }, "/home/u").allowedRoots)
      .toEqual(["/home/u/repos/", "/home/u/wt", "/home/u/.dori/runner/lanes"]);
  });

  test("without allowedRoots (or with []) the roots are derived: temp, home only without reposRoot/worktreeRoot, then the lanes directory", () => {
    const agents = { omo: ["omo", "run"] };
    const roots = (v: Record<string, unknown>) => parsePolicy({ agents, ...v }, "/home/u", "/tmp").allowedRoots;
    const lanes = "/home/u/.dori/runner/lanes";
    expect(roots({ reposRoot: "~/repos" })).toEqual(["/tmp", lanes, "/home/u/repos", "/home/u/repos/worktrees"]);
    expect(roots({ allowedRoots: [], reposRoot: "/data/repos", defaultCwd: "~/work" })).toEqual(["/tmp", lanes, "/data/repos", "/data/repos/worktrees"]);
    expect(roots({ worktreeRoot: "/srv/wt" })).toEqual(["/tmp", lanes, "/srv/wt"]);
    expect(roots({})).toEqual(["/tmp", "/home/u"]);
    // A listed allowedRoots derives nothing.
    expect(roots({ allowedRoots: ["/srv"], reposRoot: "/data/repos" })).toEqual(["/srv", lanes, "/data/repos", "/data/repos/worktrees"]);
  });

  test("derived roots admit reposRoot and temp but refuse home and the runner directory when reposRoot is set", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "runner-cmd-policy-")));
    const [home, tmp] = [join(base, "home"), join(base, "tmp")];
    const reposRoot = join(home, "repos");
    for (const dir of [join(reposRoot, "a"), join(home, ".dori", "runner"), join(tmp, "job")]) mkdirSync(dir, { recursive: true });
    const p = parsePolicy({ agents: { omo: ["omo", "run"] }, reposRoot }, home, tmp);
    expect(checkCommand(p, start({ cwd: join(reposRoot, "a") }), realpathSync).ok).toBe(true);
    expect(checkCommand(p, start({ cwd: join(tmp, "job") }), realpathSync).ok).toBe(true);
    expect(rejection(checkCommand(p, start({ cwd: home }), realpathSync))).toBe("RUNNER_CMD_REJECTED cwd-outside-roots");
    expect(rejection(checkCommand(p, start({ cwd: join(home, ".dori", "runner") }), realpathSync))).toBe("RUNNER_CMD_REJECTED cwd-outside-roots");
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

describe("runner-config grants", () => {
  const home = "/home/u";
  const parse = (grants: unknown, runtimeDir?: string) => parsePolicy({ grants }, home, "/tmp", { runnerDir: "/home/u/.dori/runner", platform: "linux", ...(runtimeDir ? { runtimeDir } : {}) });
  const refusal = (grants: unknown, runtimeDir?: string): string => {
    try { parse(grants, runtimeDir); return "parsed"; } catch (e) { return (e as Error).message; }
  };

  test("a named table of write and read paths parses, ~ expanded; either list may be absent", () => {
    expect(parse({ "blog-topic": { write: ["/data/dori/blog-writer/runs"] }, notes: { read: ["~/notes"] } }).grants).toEqual({
      "blog-topic": { write: ["/data/dori/blog-writer/runs"], read: [] }, notes: { write: [], read: ["/home/u/notes"] },
    });
  });

  test("the table may not name ~/.dori, ~/.config, the user runtime dir (bus), home or anything above it", () => {
    for (const path of ["~/.dori", "~/.dori/state", "~/.config/gh", "~/", "/home", "/", "/run/user/1000/bus", "/xdg/bus", "/home/u/.config/../.dori/env"]) {
      expect(refusal({ g: { write: [path] } }, "/xdg")).toMatch(/^runner-config: grants\.g\.write /);
      expect(refusal({ g: { read: [path] } }, "/xdg")).toMatch(/^runner-config: grants\.g\.read /);
    }
  });

  test("a relative or colon path, an empty entry, an unknown key or a bad name is refused", () => {
    expect(refusal({ g: { write: ["data/x"] } })).toContain("is not absolute");
    expect(refusal({ g: { write: ["/data/a:/data/b"] } })).toContain("holds ':'");
    expect(refusal({ g: {} })).toContain("names no path");
    expect(refusal({ g: { write: ["/data/x"], exec: ["/data/y"] } })).toContain("unknown key grants.g.exec");
    expect(refusal({ "Bad Name": { write: ["/data/x"] } })).toContain("grants key Bad Name");
    expect(refusal(["/data/x"])).toContain("grants must be an object");
  });

  const granted: RunnerPolicy = { ...policy, grants: { "blog-topic": { write: ["/data/dori/blog-writer/runs"], read: [] } } };

  test("lane.start grants: a name in the table passes, any other is RUNNER_CMD_REJECTED grant-unknown, and an unsandboxed start may not carry one", () => {
    expect(checkCommand(granted, start({ grants: ["blog-topic"] }), realpath).ok).toBe(true);
    expect(rejection(checkCommand(granted, start({ grants: ["blog-topic", "nope"] }), realpath))).toBe("RUNNER_CMD_REJECTED grant-unknown");
    expect(rejection(checkCommand(policy, start({ grants: ["blog-topic"] }), realpath))).toBe("RUNNER_CMD_REJECTED grant-unknown");
    expect(rejection(checkCommand({ ...granted, sandbox: "optional" }, start({ sandbox: false, grants: ["blog-topic"] }), realpath))).toBe("RUNNER_CMD_REJECTED grant-unsandboxed");
    expect(rule(start({ grants: "blog-topic" }), granted)).toBe("field-type");
  });

  test("resolveGrants follows symlinks into refused places, refuses a checkout as a write grant, and drops repeats", () => {
    const real: Record<string, string> = { "/data/runs": "/data/runs", "/data/sneaky": "/home/u/.dori/state", "/data/repo": "/data/repo" };
    const o = { home, realpath: (p: string) => { const r = real[p]; if (!r) throw new Error("ENOENT"); return r; }, isCheckout: (p: string) => p === "/data/repo" };
    const table = (write: string[], read: string[] = []) => ({ grants: { g: { write, read }, h: { write: ["/data/runs"], read: [] } } });
    expect(resolveGrants(table(["/data/runs", "/data/missing"]), ["g", "h"], o)).toEqual({ write: ["/data/runs", "/data/missing"], read: [] });
    expect(() => resolveGrants(table(["/data/sneaky"]), ["g"], o)).toThrow("RUNNER_CMD_REJECTED grant-path g.write /data/sneaky overlaps /home/u/.dori");
    expect(() => resolveGrants(table(["/data/repo"]), ["g"], o)).toThrow("RUNNER_CMD_REJECTED grant-path g.write /data/repo is a git checkout");
    expect(resolveGrants(table([], ["/data/repo"]), ["g"], o).read).toEqual(["/data/repo"]);
    expect(() => resolveGrants(table([]), ["gone"], o)).toThrow("RUNNER_CMD_REJECTED grant-unknown gone");
  });
});
