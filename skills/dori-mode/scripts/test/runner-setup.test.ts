import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyPrompter } from "../src/config-keys.ts";
import { sshArgv } from "../src/remote-guard.ts";
import type { RunOptions } from "../src/run.ts";
import { localRunnerConfigIO, remoteRunnerConfigIO, REMOTE_ABSENT, runRunnerSetup, type RunnerSetupDeps } from "../src/runner/runner-setup.ts";

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "runner-setup-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BASE = { agents: { default: ["pi", "{prompt}"] }, allowedRoots: ["/tmp"] };

/** Answers by key (the first word of the question); an unlisted key gets Enter (the current value). */
const prompter = (answers: Record<string, string> = {}, confirm = false): KeyPrompter & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    ask: async (question, current) => {
      const key = question.split(" ")[0]!;
      asked.push(key);
      return answers[key] ?? current;
    },
    confirm: async () => confirm,
  };
};

const setup = (dir: string, over: Partial<RunnerSetupDeps> = {}) => {
  const lines: string[] = [];
  const deps: RunnerSetupDeps = {
    io: localRunnerConfigIO(dir), prompt: prompter(), interactive: false, log: (l) => lines.push(l),
    seenPath: join(dir, "seen.json"), mode: "full", home: "/home/u", ...over,
  };
  return { deps, lines };
};

const cfgPath = (dir: string) => join(dir, "runner-config.json");
const readCfg = (dir: string) => JSON.parse(readFileSync(cfgPath(dir), "utf8"));

describe("localRunnerConfigIO", () => {
  test("round trips with mode 0600 and reads an absent file as undefined", async () => {
    const dir = join(temp(), "runner");
    const io = localRunnerConfigIO(dir);
    expect(await io.read()).toBeUndefined();
    await io.write("{}\n");
    await io.backup("old\n");
    expect(await io.read()).toBe("{}\n");
    expect(statSync(cfgPath(dir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${cfgPath(dir)}.bak`, "utf8")).toBe("old\n");
    expect(statSync(`${cfgPath(dir)}.bak`).mode & 0o777).toBe(0o600);
  });
});

describe("runRunnerSetup", () => {
  test("prunes an unknown key and guard.foo, writing a .bak first", async () => {
    const dir = temp();
    const old = JSON.stringify({ ...BASE, listen: "x", guard: { panesMax: 4, foo: 1 } });
    writeFileSync(cfgPath(dir), old);
    const { deps, lines } = setup(dir);
    expect(await runRunnerSetup(deps, { patch: {}, unset: [] })).toBe(0);
    expect(readFileSync(`${cfgPath(dir)}.bak`, "utf8")).toBe(old);
    expect(readCfg(dir)).toEqual({ ...BASE, guard: { panesMax: 4 } });
    expect(lines).toContain("RUNNER_SETUP_KEY_REMOVED listen (runner-config.json no longer reads it)");
    expect(lines).toContain("RUNNER_SETUP_KEY_REMOVED guard.foo (runner-config.json no longer reads it)");
    expect(lines).toContain(`RUNNER_SETUP_WRITTEN ${cfgPath(dir)}`);
  });

  test("applies a --set patch without asking and records it as seen", async () => {
    const dir = temp();
    writeFileSync(cfgPath(dir), JSON.stringify(BASE));
    const prompt = prompter();
    const { deps, lines } = setup(dir, { prompt, interactive: true });
    expect(await runRunnerSetup(deps, { patch: { jobs: "deny" }, unset: [] })).toBe(0);
    expect(readCfg(dir).jobs).toBe("deny");
    expect(prompt.asked).not.toContain("jobs");
    expect(lines).toContain("SETUP_KEY_SET jobs");
    expect(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"))).toContain("jobs");
  });

  test("a result parsePolicy refuses writes nothing", async () => {
    const dir = temp();
    const old = JSON.stringify(BASE);
    writeFileSync(cfgPath(dir), old);
    const { deps, lines } = setup(dir);
    expect(await runRunnerSetup(deps, { patch: { defaultCwd: "relative/path" }, unset: [] })).toBe(1);
    expect(readFileSync(cfgPath(dir), "utf8")).toBe(old);
    expect(lines.at(-1)).toMatch(/^RUNNER_SETUP_FAILED invalid runner-config: .*defaultCwd.*; nothing was written$/);
  });

  test("invalid JSON fails without writing", async () => {
    const dir = temp();
    writeFileSync(cfgPath(dir), "{nope");
    const { deps, lines } = setup(dir);
    expect(await runRunnerSetup(deps, { patch: { jobs: "deny" }, unset: [] })).toBe(1);
    expect(readFileSync(cfgPath(dir), "utf8")).toBe("{nope");
    expect(lines[0]).toMatch(/^RUNNER_SETUP_FAILED .* is not valid JSON \(.*\); fix it by hand$/);
  });

  test("an absent file with nothing to set is skipped non-interactively and nothing is created", async () => {
    const dir = temp();
    const { deps, lines } = setup(dir);
    expect(await runRunnerSetup(deps, { patch: {}, unset: [] })).toBe(0);
    expect(lines).toEqual([`RUNNER_SETUP_SKIPPED no runner-config.json at ${cfgPath(dir)}`]);
    expect(existsSync(cfgPath(dir))).toBe(false);
    expect(existsSync(join(dir, "seen.json"))).toBe(false);
  });

  test("mode new asks only unseen keys and reports missing required keys", async () => {
    const dir = temp();
    writeFileSync(cfgPath(dir), JSON.stringify({ agents: BASE.agents }));
    const seenKeys = ["agents", "defaultCwd", "sandbox", "jobs", "guard", "heavyKill", "sandboxCheck", "workspaces", "detectWorkspaces", "reposRoot"];
    writeFileSync(join(dir, "seen.json"), JSON.stringify(seenKeys));
    const prompt = prompter({ worktreeRoot: "~/wt" });
    const { deps, lines } = setup(dir, { prompt, interactive: true, mode: "new" });
    expect(await runRunnerSetup(deps, { patch: {}, unset: [] })).toBe(2);
    expect(prompt.asked).toEqual(["allowedRoots", "worktreeRoot"]);
    expect(readCfg(dir)).toEqual({ agents: BASE.agents, worktreeRoot: "~/wt" });
    expect(lines).toContain("RUNNER_SETUP_KEY_MISSING allowedRoots [required]");
    expect(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"))).toEqual([...seenKeys, "allowedRoots", "worktreeRoot"].sort());
  });

  test("an unchanged file is not rewritten", async () => {
    const dir = temp();
    const old = `${JSON.stringify(BASE)}\n`;
    writeFileSync(cfgPath(dir), old);
    const { deps, lines } = setup(dir);
    expect(await runRunnerSetup(deps, { patch: {}, unset: [] })).toBe(0);
    expect(readFileSync(cfgPath(dir), "utf8")).toBe(old);
    expect(lines).toEqual([`RUNNER_SETUP_UNCHANGED ${cfgPath(dir)}`]);
  });
});

describe("remoteRunnerConfigIO posix", () => {
  const machine = { label: "box", target: "u@box" };
  const fake = (out: string, code = 0) => {
    const calls: { argv: readonly string[]; opts?: RunOptions }[] = [];
    const run = async (argv: readonly string[], opts?: RunOptions) => {
      calls.push({ argv, opts });
      return { code, out, err: code ? "boom\n" : "" };
    };
    return { calls, run };
  };

  test("read maps the absent sentinel to undefined and returns the file otherwise", async () => {
    const absent = fake(`${REMOTE_ABSENT}\n`);
    expect(await remoteRunnerConfigIO(absent.run, machine, "posix").read()).toBeUndefined();
    expect(absent.calls[0]!.argv).toEqual(sshArgv("u@box", "sh -s"));
    expect(absent.calls[0]!.opts?.stdin).toContain(REMOTE_ABSENT);
    const present = fake('{"jobs":"deny"}\n');
    expect(await remoteRunnerConfigIO(present.run, machine, "posix").read()).toBe('{"jobs":"deny"}\n');
  });

  test("write and backup carry base64 content on stdin, not the raw JSON", async () => {
    const f = fake("");
    const io = remoteRunnerConfigIO(f.run, machine, "posix");
    const text = `${JSON.stringify(BASE, null, 2)}\n`;
    await io.write(text);
    await io.backup(text);
    for (const call of f.calls) {
      expect(call.argv).toEqual(sshArgv("u@box", "sh -s"));
      expect(call.opts?.stdin).toContain(Buffer.from(text).toString("base64"));
      expect(call.opts?.stdin).not.toContain('"agents"');
      expect(call.opts?.stdin).toContain("umask 077");
      expect(call.opts?.stdin).toContain("base64 -d");
    }
    expect(f.calls[0]!.opts?.stdin).toContain('f="$d/runner-config.json"');
    expect(f.calls[1]!.opts?.stdin).toContain('f="$d/runner-config.json.bak"');
  });

  test("a non-zero exit throws RUNNER_SETUP_REMOTE_FAILED", async () => {
    const f = fake("", 1);
    await expect(remoteRunnerConfigIO(f.run, machine, "posix").write("{}\n")).rejects.toThrow(/^RUNNER_SETUP_REMOTE_FAILED box: boom$/);
  });
});
