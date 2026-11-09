import { expect, test } from "bun:test";

import {
  agentCommandLine, laneEnv, laneSandboxWindowsMain, type LaneSandboxDeps, mxcBuildRefusal, mxcPolicy, mxcProbeRefusal,
  parseWindowsBuild, quoteWindowsArg, sandboxKey, sshPrivateKeys, windowsCommandLine, wxcExecPath,
} from "../src/runner/lane-sandbox-windows.ts";
import type { Ran } from "../src/run.ts";

const HOME = "C:\\Users\\me";
const DORI = `${HOME}\\.dori`;
const RUNNER = `${DORI}\\runner`;
const WT = "D:\\work\\repo\\wt-1";
const GCD = "D:\\work\\repo\\.git";
const TMP = `${HOME}\\.cache\\omo-tmp\\lane-sandbox\\lane-a`;
const ENV = { SystemRoot: "C:\\WINDOWS", LOCALAPPDATA: `${HOME}\\AppData\\Local`, PATH: `${RUNNER}\\bin;C:\\WINDOWS\\system32`, TEMP: "C:\\old-temp", DORI_LANE_KEY: "lane-a" };

const policy = (over: Partial<Parameters<typeof mxcPolicy>[0]> = {}) => mxcPolicy({
  home: HOME, cwd: WT, key: "lane-a", laneTmp: TMP, systemDrive: "C:", commandLine: "omo.exe x", env: ENV,
  tokenFile: `${RUNNER}\\briefs\\lane-a.2.token`, gitCommonDir: GCD, sshKeys: [`${HOME}\\.ssh\\id_ed25519`], ...over,
});
const lower = (paths: readonly string[]): string[] => paths.map((p) => p.toLowerCase());

test("a lane writes only its worktree, git dir, TEMP and the caches; its volumes are read-only and ~/.dori is denied but for what it needs", () => {
  const p = policy({ rw: ["E:\\scratch", ""], verify: "C:\\lead\\state\\verify" });
  expect(p.filesystem.readwritePaths).toEqual([
    TMP, `${HOME}\\.omo`, `${HOME}\\.cache`, `${DORI}\\state`, `${DORI}\\heavy`, `${HOME}\\.npm`, `${HOME}\\.bun\\install\\cache`,
    `${HOME}\\.cargo\\registry`, `${HOME}\\.cargo\\git`, "E:\\scratch", "C:\\lead\\state\\verify", WT, GCD, `${RUNNER}\\sock\\lane`,
  ]);
  expect(p.filesystem.readonlyPaths).toEqual([
    "C:\\", "D:\\", `${DORI}\\config.json`, `${DORI}\\src`, `${DORI}\\bin`, `${RUNNER}\\bin`, `${RUNNER}\\bun`,
    `${RUNNER}\\briefs\\lane-a.md`, `${RUNNER}\\briefs\\lane-a.2.token`, `${GCD}\\hooks`,
  ]);
  expect(p.filesystem.deniedPaths).toEqual([DORI, `${DORI}\\env`, `${HOME}\\.ssh\\id_ed25519`]);
  // Nothing else of the runner directory: other lanes' briefs and tokens, its keys, config and other sockets stay under the denied ~/.dori.
  const granted = lower([...p.filesystem.readwritePaths, ...p.filesystem.readonlyPaths]);
  for (const hidden of ["briefs\\lane-b.md", "briefs", "keys", "runner-config.json", "sock\\control", "sock\\cli", "sock", "mxc"]) expect(granted).not.toContain(`${RUNNER}\\${hidden}`.toLowerCase());
  expect(granted).not.toContain(`${DORI}\\env`.toLowerCase());
  expect(p).toMatchObject({
    version: "1.0.0", containment: "processcontainer", containerId: "dori-lane-lane-a",
    process: { commandLine: "omo.exe x", cwd: WT, timeout: 0 },
    network: { egress: { default: "allow" }, ingress: { default: "deny", hostLoopback: "allow" } },
    ui: { disable: false, clipboard: "none", injection: false }, telemetry: { enabled: false },
  });
});

test("a cwd that is a volume root, the profile, the profiles folder or listed in LANE_SANDBOX_NO_CWD is not made writable", () => {
  for (const cwd of ["D:\\", HOME, "c:\\users\\me\\", "C:\\Users", "D:\\work\\repo"]) {
    const p = policy({ cwd, noCwd: ["D:\\work\\repo"] });
    expect(lower(p.filesystem.readwritePaths)).not.toContain(cwd.toLowerCase().replace(/\\$/, "") || cwd.toLowerCase());
    expect(p.filesystem.readwritePaths).not.toContain(GCD);
    expect(p.filesystem.readonlyPaths).not.toContain(`${GCD}\\hooks`);
  }
});

test("paths are normalized and deduplicated without case, and a missing git dir or token adds nothing", () => {
  const p = policy({ cwd: "d:/work/repo/wt-1/", rw: ["D:\\WORK\\repo\\wt-1"], gitCommonDir: undefined, tokenFile: undefined, sshKeys: [] });
  expect(p.filesystem.readwritePaths.filter((x) => x.toLowerCase() === WT.toLowerCase())).toHaveLength(1);
  expect(p.process.cwd).toBe("d:\\work\\repo\\wt-1");
  expect(p.filesystem.readonlyPaths.some((x) => x.endsWith(".token") || x.endsWith("hooks"))).toBe(false);
  expect(p.filesystem.deniedPaths).toEqual([DORI, `${DORI}\\env`]);
});

test("the agent's environment keeps the pane's, with TEMP, TMP and TMPDIR on the lane's TEMP; MXC's required names must be there", () => {
  const env = laneEnv({ ...ENV, temp: "x", Path: "dup" }, TMP);
  expect(env).toContain(`TEMP=${TMP}`);
  expect(env).toContain(`TMP=${TMP}`);
  expect(env).toContain(`TMPDIR=${TMP}`);
  expect(env).toContain("LANE_SANDBOX_ACTIVE=1");
  expect(env).toContain("DORI_LANE_KEY=lane-a");
  expect(env.filter((e) => /^path=/i.test(e))).toEqual(["Path=dup"]);
  expect(env.filter((e) => /^temp=/i.test(e))).toHaveLength(1);
  expect(() => laneEnv({ PATH: "x" }, TMP)).toThrow("SYSTEMROOT and LOCALAPPDATA must be set");
});

test("Windows arguments are quoted the way CommandLineToArgvW reads them back", () => {
  expect(quoteWindowsArg("plain")).toBe("plain");
  expect(quoteWindowsArg("")).toBe('""');
  expect(quoteWindowsArg("a b")).toBe('"a b"');
  expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
  expect(quoteWindowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
  expect(quoteWindowsArg('a\\"b')).toBe('"a\\\\\\"b"');
  expect(quoteWindowsArg("C:\\no\\space\\")).toBe("C:\\no\\space\\");
  expect(windowsCommandLine(["C:\\bin\\omo.exe", "--model", "m", "ulw. Read the brief; you're the lane"])).toBe('C:\\bin\\omo.exe --model m "ulw. Read the brief; you\'re the lane"');
});

test("the agent program is resolved on PATH: an exe runs directly, a batch file through cmd.exe, a script through powershell -File", () => {
  const which = (paths: Record<string, string>) => (cmd: string): string | null => paths[cmd] ?? null;
  expect(agentCommandLine(["omo", "a b"], which({ omo: "C:\\tools\\omo.exe" }))).toBe('C:\\tools\\omo.exe "a b"');
  expect(agentCommandLine(["omo", "a b"], which({ omo: "C:\\npm\\omo.CMD" }))).toBe('cmd.exe /d /s /c "C:\\npm\\omo.CMD "a b""');
  expect(agentCommandLine(["omo", "x"], which({ omo: "C:\\npm\\omo.ps1" }))).toBe("powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\\npm\\omo.ps1 x");
  expect(() => agentCommandLine(["omo", "100%"], which({ omo: "C:\\npm\\omo.cmd" }))).toThrow("cannot pass the argument");
  expect(() => agentCommandLine(["omo", 'say "x"'], which({ omo: "C:\\npm\\omo.bat" }))).toThrow("cannot pass the argument");
  expect(() => agentCommandLine(["omo"], which({}))).toThrow("omo is not on PATH");
});

const REG = (build: number, ubr: number) =>
  `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    SystemRoot    REG_SZ    C:\\WINDOWS\r\n    CurrentBuildNumber    REG_SZ    ${build}\r\n    CurrentBuild    REG_SZ    ${build}\r\n    UBR    REG_DWORD    0x${ubr.toString(16)}\r\n`;

test("the Windows build is read from reg query and gated on the MXC release table", () => {
  expect(parseWindowsBuild(REG(26100, 9278))).toEqual({ build: 26100, ubr: 9278 });
  expect(parseWindowsBuild("    CurrentBuildNumber    REG_SZ    26100\n")).toBeUndefined();
  for (const ok of [[26100, 9278], [26200, 9300], [26300, 9550], [28000, 2804], [29500, 1]] as const) expect(mxcBuildRefusal({ build: ok[0], ubr: ok[1] })).toBeUndefined();
  expect(mxcBuildRefusal({ build: 26100, ubr: 9277 })).toBe("Windows build 26100.9277 is missing the cumulative update that adds ProcessContainer (needs 26100.9278 or later); sandboxed lanes need Windows 11 24H2 (build 26100.9278) or 25H2 (26200.9278) with the 2026-08 cumulative update (KB5120998) or later, 26H2 (26300.9550) or 26H1 (28000.2804)");
  expect(mxcBuildRefusal({ build: 26300, ubr: 9000 })).toContain("needs 26300.9550 or later");
  expect(mxcBuildRefusal({ build: 19045, ubr: 6000 })).toStartWith("Windows build 19045.6000 has no MXC ProcessContainer support; sandboxed lanes need Windows 11 24H2");
  expect(mxcBuildRefusal({ build: 22631, ubr: 5000 })).toContain("has no MXC ProcessContainer support");
});

const PROBE = (probes: Record<string, boolean>, error?: string) => JSON.stringify({ ...(error ? {} : { tier: "native" }), warnings: [], probes, ...(error ? { error } : {}) }, null, 2);

test("the executor's probe decides: an error, a failed run, no BaseContainer or no deny paths refuse", () => {
  expect(mxcProbeRefusal(0, PROBE({ baseContainerApiPresent: true, baseContainerSupportsDenyPaths: true }), "")).toBeUndefined();
  expect(mxcProbeRefusal(1, PROBE({ baseContainerApiPresent: false }, "PSEC is unavailable on this host"), "")).toBe("MXC cannot enforce the lane policy here: PSEC is unavailable on this host");
  expect(mxcProbeRefusal(1, "", "malformed request\n")).toBe("wxc-exec --probe failed (exit 1): malformed request");
  expect(mxcProbeRefusal(0, PROBE({ baseContainerApiPresent: false, baseContainerSupportsDenyPaths: false }), "")).toContain("no ProcessContainer (BaseContainer) API");
  expect(mxcProbeRefusal(0, PROBE({ baseContainerApiPresent: true, baseContainerSupportsDenyPaths: false }), "")).toContain("no PSE_SUPPORT_FS_DENY");
});

test("lane keys and ssh private keys are reduced like the shell wrappers do", () => {
  expect(sandboxKey("a/b c")).toBe("a_b_c");
  expect(sandboxKey("..")).toBe("_..");
  expect(sshPrivateKeys(`${HOME}\\.ssh`, ["id_rsa", "id_rsa.pub", "id_ed25519", "known_hosts", "config", "id_x.bak"])).toEqual([`${HOME}\\.ssh\\id_rsa`, `${HOME}\\.ssh\\id_ed25519`]);
});

/** A Windows host with MXC: reg query answers `build`, the executor exists and its probe answers `probe`. */
const host = (over: { build?: string; probe?: Partial<Ran>; wxc?: boolean; env?: Record<string, string> } = {}) => {
  const calls: (readonly string[])[] = [];
  const files = new Map<string, string>();
  const spawned: { argv: readonly string[]; cwd: string }[] = [];
  const errs: string[] = [];
  const wxc = wxcExecPath(RUNNER);
  const deps: Partial<LaneSandboxDeps> = {
    platform: "win32", env: over.env ?? ENV, home: HOME, runnerDir: RUNNER, cwd: () => WT,
    run: async (argv) => {
      calls.push(argv);
      if (argv[0] === "reg.exe") return { code: 0, out: over.build ?? REG(26100, 9300), err: "" };
      if (argv[0] === "git") return { code: 0, out: "D:/work/repo/.git\n", err: "" };
      if (argv[0] === wxc) return { code: 0, out: PROBE({ baseContainerApiPresent: true, baseContainerSupportsDenyPaths: true }), err: "", ...over.probe };
      return { code: 127, out: "", err: "unexpected" };
    },
    which: (cmd) => (cmd === "omo" ? "C:\\tools\\omo.exe" : null),
    exists: (path) => (path === wxc ? over.wxc ?? true : path.toLowerCase() === GCD.toLowerCase()),
    listDir: () => ["id_rsa", "id_rsa.pub"],
    mkdir: () => {},
    writeFile: (path, text) => { files.set(path, text); },
    spawn: async (argv, cwd) => { spawned.push({ argv, cwd }); return 7; },
    err: (line) => { errs.push(line); },
  };
  return { deps, calls, files, spawned, errs, wxc };
};

test("--check probes the same policy shape a lane gets and refuses an unsupported host with the requirement", async () => {
  const ok = host();
  expect(await laneSandboxWindowsMain(["--check"], ok.deps)).toBe(0);
  const probeCall = ok.calls.find((c) => c[0] === ok.wxc) ?? [];
  expect(probeCall.slice(1, 3)).toEqual(["--probe", "--config"]);
  const checked = JSON.parse(ok.files.get(probeCall[3] ?? "") ?? "{}");
  expect(checked.filesystem.deniedPaths).toContain(`${DORI}\\env`);
  expect(checked.filesystem.readwritePaths).not.toContain(HOME);
  expect(ok.errs).toEqual([]);

  const old = host({ build: REG(22631, 4000) });
  expect(await laneSandboxWindowsMain(["--check"], old.deps)).toBe(3);
  expect(old.errs[0]).toStartWith("lane-sandbox: Windows build 22631.4000 has no MXC ProcessContainer support; sandboxed lanes need Windows 11 24H2");
  expect(old.calls.some((c) => c[0] === old.wxc)).toBe(false);

  const missing = host({ wxc: false });
  expect(await laneSandboxWindowsMain(["--check"], missing.deps)).toBe(3);
  expect(missing.errs[0]).toBe(`lane-sandbox: ${missing.wxc} is missing; rerun dori runner install for this machine from the lead`);

  const noDeny = host({ probe: { code: 1, out: PROBE({ baseContainerApiPresent: true }, "deniedPaths requires PSE_SUPPORT_FS_DENY") } });
  expect(await laneSandboxWindowsMain(["--check"], noDeny.deps)).toBe(3);
  expect(noDeny.errs[0]).toBe("lane-sandbox: MXC cannot enforce the lane policy here: deniedPaths requires PSE_SUPPORT_FS_DENY");

  const linux = host();
  expect(await laneSandboxWindowsMain(["--check"], { ...linux.deps, platform: "linux" })).toBe(3);
  expect(linux.errs[0]).toBe("lane-sandbox: the MXC lane sandbox runs only on Windows (this is linux)");
});

test("a lane runs its agent through wxc-exec with the written policy and exits with its code; no lane key runs it bare", async () => {
  const lane = host({ env: { ...ENV, DORI_LANE_TOKEN_FILE: `${RUNNER}\\briefs\\lane-a.3.token`, LANE_SANDBOX_RW: "E:\\a;E:\\b" } });
  expect(await laneSandboxWindowsMain(["omo", "--model", "m", "do it"], lane.deps)).toBe(7);
  expect(lane.spawned).toHaveLength(1);
  const [wxc, flag, config] = lane.spawned[0]?.argv ?? [];
  expect([wxc, flag]).toEqual([lane.wxc, "--config"]);
  expect(config).toBe(`${TMP}\\mxc-policy.json`);
  expect(lane.spawned[0]?.cwd).toBe(WT);
  const written = JSON.parse(lane.files.get(config ?? "") ?? "{}");
  expect(written.process.commandLine).toBe('C:\\tools\\omo.exe --model m "do it"');
  expect(written.filesystem.readwritePaths).toEqual(expect.arrayContaining(["E:\\a", "E:\\b", WT, GCD]));
  expect(written.filesystem.readonlyPaths).toEqual(expect.arrayContaining([`${RUNNER}\\briefs\\lane-a.3.token`, `${GCD}\\hooks`]));
  expect(written.filesystem.deniedPaths).toEqual([DORI, `${DORI}\\env`, `${HOME}\\.ssh\\id_rsa`]);

  const bare = host({ env: { ...ENV, DORI_LANE_KEY: "" } });
  expect(await laneSandboxWindowsMain(["omo", "x"], bare.deps)).toBe(7);
  expect(bare.spawned).toEqual([{ argv: ["omo", "x"], cwd: WT }]);
  expect(bare.calls).toEqual([]);

  const unsupported = host({ build: REG(26100, 100) });
  expect(await laneSandboxWindowsMain(["omo"], unsupported.deps)).toBe(3);
  expect(unsupported.spawned).toEqual([]);
  expect(unsupported.errs[0]).toContain("needs 26100.9278 or later");

  const usage = host();
  expect(await laneSandboxWindowsMain([], usage.deps)).toBe(2);
});
