import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ran } from "../src/run.ts";
import { paneShell } from "../src/runner/lane-control.ts";
import { powershellLaunchLine, RunnerLanes } from "../src/runner/lanes.ts";
import { fakeClock } from "./fakes.ts";

const FILES = { run: { id: "00000000-0000-4000-8000-000000000001", requiredReport: false }, tree: { directories: [], files: [] }, references: [] };

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const START = { cmdId: "c1", key: "lane-a", briefText: "# brief\n", done: "x", thread: "none", cwd: "/repo", agentProfile: "omo", mode: "ulw", model: "m1", sandbox: true, expectedLaneGen: 0, files: FILES };

const decode = (line: string, shell: string): string => {
  const m = new RegExp(`^${shell} -NoLogo -EncodedCommand ([A-Za-z0-9+/=]+)$`).exec(line);
  expect(m).not.toBeNull();
  return Buffer.from(m?.[1] ?? "", "base64").toString("utf16le");
};

/** A RunnerLanes over a scripted herdr whose fresh pane runs `shellName`. */
const setup = (shellName: string, agent = ["omo", "--model", "{model}", "{prompt}"]) => {
  const runnerDir = join(mkdtempSync(join(tmpdir(), "win-lanes-")), "runner");
  dirs.push(join(runnerDir, ".."));
  mkdirSync(runnerDir, { mode: 0o700 });
  const calls: string[][] = [];
  const ok = (out = ""): Ran => ({ code: 0, out, err: "" }) as Ran;
  const lanes = new RunnerLanes({
    instance: async () => "server-1", runnerDir, clock: fakeClock(1_800_000_000_000), token: () => "tok", realpath: (p: string) => p,
    legacyMcp: async () => false, startup: async () => ({ verdict: "ok", detail: "ready" }),
    policy: { agents: { omo: agent }, allowedRoots: ["/repo"], sandbox: "optional", jobs: "allow", sandboxCheck: ["lane-sandbox", "--check"] },
    publish: () => {},
    run: async (argv) => {
      calls.push([...argv]);
      if (argv[0] === "lane-sandbox" && argv.includes("--check")) return { code: 0, out: "DORI_LANE_FILES=1\n", err: "" } as Ran;
      const verb = argv.slice(0, 3).join(" ");
      if (verb === "herdr tab create") return ok(JSON.stringify({ result: { tab_id: "t1", root_pane: { pane_id: "p1", tab_id: "t1" } } }));
      if (verb === "herdr pane get") return ok(JSON.stringify({ result: { pane: { pane_id: "p1", cwd: "C:\\repo" } } }));
      if (verb === "herdr pane process-info") {
        return ok(JSON.stringify({ result: { process_info: { shell_pid: 4242, foreground_process_group_id: 4242, foreground_processes: [{ pid: 4242, name: shellName }] } } }));
      }
      return ok();
    },
  });
  return { lanes, calls };
};

const typed = (calls: string[][]): string => calls.find((a) => a[1] === "pane" && a[2] === "run")?.[4] ?? "";

test("a pwsh pane gets a nested encoded command with env, quoting and argv order", async () => {
  const t = setup("pwsh.exe");
  await t.lanes.start({ ...START, heavySlots: 2, heavyMaxLoad: 3 });
  const line = typed(t.calls);
  const tokenFile = t.lanes.tokenPath("lane-a");
  const script = decode(line, "pwsh");
  expect(script).toStartWith(`$env:DORI_LANE_KEY='lane-a'; $env:DORI_LANE_TOKEN_FILE='${tokenFile.replace(/'/g, "''")}'; $env:DORI_LANE_OUT='${join(tokenFile, "..", "lane-a.out").replace(/'/g, "''")}'; $env:DORI_HEAVY_SLOTS='2'; $env:DORI_HEAVY_MAX_LOAD='3'; $env:PSExecutionPolicyPreference='Bypass'; & 'omo' '--model' 'm1' '`);
  expect(script).toEndWith("'; exit $LASTEXITCODE");
  expect(script).not.toContain("DORI_LANE_TOKEN='");
  expect(t.calls.some((a) => a.join(" ").includes("-NoProfile"))).toBe(false);
});

test("the lane record stores the pane's shell pid", async () => {
  const t = setup("pwsh");
  await t.lanes.start(START);
  expect(t.lanes.records()["lane-a"]?.shellPid).toBe(4242);
});

test("single quotes are doubled in values and arguments", () => {
  const line = powershellLaunchLine("pwsh", [["DORI_LANE_KEY", "it's"]], ["agent.exe", "a b", "x'y", "$env:HOME"]);
  expect(decode(line, "pwsh")).toBe("$env:DORI_LANE_KEY='it''s'; $env:PSExecutionPolicyPreference='Bypass'; & 'agent.exe' 'a b' 'x''y' '$env:HOME'; exit $LASTEXITCODE");
});

test("Windows PowerShell 5.1 refuses a double quote in argv, pwsh allows it", async () => {
  const quoted = ["omo", 'say "hi"'];
  expect(() => powershellLaunchLine("powershell", [], quoted)).toThrow("RUNNER_LANE_ARGV_UNSAFE");
  expect(decode(powershellLaunchLine("pwsh", [], quoted), "pwsh")).toContain(`'say "hi"'`);
  expect(decode(powershellLaunchLine("powershell", [], ["omo", "plain"]), "powershell")).toContain("& 'omo' 'plain'");

  const t = setup("powershell.exe", ["omo", 'a"b', "{prompt}"]);
  await expect(t.lanes.start(START)).rejects.toThrow("RUNNER_LANE_ARGV_UNSAFE");
  expect(typed(t.calls)).toBe("");
  expect(t.calls.some((a) => a[1] === "tab" && a[2] === "close")).toBe(true);
  expect(t.lanes.records()["lane-a"]).toBeUndefined();
});

test("a POSIX pane keeps the unchanged KEY=value line and a cmd pane is refused", async () => {
  const posix = setup("zsh");
  await posix.lanes.start(START);
  expect(typed(posix.calls)).toStartWith("DORI_LANE_KEY=lane-a DORI_LANE_TOKEN_FILE=");
  expect(typed(posix.calls)).toContain(" omo --model m1 ");
  const cmd = setup("cmd.exe");
  await expect(cmd.lanes.start(START)).rejects.toThrow("RUNNER_LANE_TARGET_INVALID");
  expect(typed(cmd.calls)).toBe("");
});

test("paneShell tells pwsh from Windows PowerShell and falls back to a drive-letter cwd", () => {
  const info = (name: string) => ({ shell_pid: 1, foreground_processes: [{ pid: 1, name }] });
  expect(paneShell(info("pwsh.exe"))).toBe("pwsh");
  expect(paneShell(info("PowerShell.EXE"))).toBe("powershell");
  expect(paneShell(info("cmd.exe"))).toBe("cmd");
  expect(paneShell(undefined, "D:\\work")).toBe("powershell");
  expect(paneShell(undefined, "/home/x")).toBe("posix");
});
