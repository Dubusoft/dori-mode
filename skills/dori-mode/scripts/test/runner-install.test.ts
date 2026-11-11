import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_EXIT, buildBundle, bundleVersion, herdrInstallNote, installRunner, installScript, remoteUnit } from "../src/runner/install.ts";
import { run as realRun, type Ran, type RunOptions } from "../src/run.ts";
import { gitVersion } from "../src/runner/version.ts";
import { checkRunnerDir } from "../src/runner/fs-safety.ts";
import { loadPolicy } from "../src/runner/policy.ts";
import { LANE_SANDBOX_MACOS_TEMPLATE, LANE_SANDBOX_TEMPLATE } from "../src/lane-sandbox-install.ts";
import { enrollOverStdio, RunnerAuth, SupervisorAuth } from "../src/runner/auth.ts";
import { readRunnerEndpoints } from "../src/runner/endpoints.ts";

const CODE = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo";
const FINGERPRINT = "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const UNIT = "ExecStart=@BUN@ %h/.dori/runner/bin/dori.js runner serve --label @LABEL@ --listen @LISTEN@\nEnvironment=PATH=@PATH@\n";
const BUNDLE = "console.log('runner bundle');\n";
const machine = { label: "worker-a", target: "dori@worker-a" };
const AGENT = ["omo", "--model", "{model}", "{prompt}"];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Call = { argv: readonly string[]; opts?: RunOptions };
const fakeRun = (result: Partial<Ran> = {}) => {
  const calls: Call[] = [];
  const run = async (argv: readonly string[], opts?: RunOptions): Promise<Ran> => {
    calls.push({ argv, ...(opts ? { opts } : {}) });
    return { code: 0, out: "", err: "", ...result } as Ran;
  };
  return { run, calls };
};
const posixKind = async () => ({ ok: true as const, kind: "posix" as const });
const request = (issued: { count: number }) => {
  const stateDir = mkdtempSync(join(tmpdir(), "runner-install-state-"));
  dirs.push(stateDir);
  return {
    machine, label: "worker-a", listenAddress: "100.101.1.2:7411", stateDir, agentCommand: AGENT,
    issue: () => { issued.count += 1; return { code: CODE, fingerprint: FINGERPRINT }; },
    enroll: () => { throw new Error("unexpected enrollment request"); },
  };
};

test("the enrollment code and fingerprint go only on stdin, never in an argv element", async () => {
  const { run, calls } = fakeRun();
  const issued = { count: 0 };
  const result = await installRunner({ run, bundle: async () => BUNDLE, unitTemplate: UNIT, kind: posixKind }, request(issued));
  expect(result).toEqual({ ok: true, version: bundleVersion(BUNDLE) });
  expect(calls).toHaveLength(1);
  const call = calls[0] as Call;
  expect(call.argv).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "dori@worker-a", "sh -s"]);
  for (const arg of call.argv) {
    expect(arg).not.toContain(CODE);
    expect(arg).not.toContain(FINGERPRINT);
  }
  const stdin = call.opts?.stdin ?? "";
  expect(stdin).toContain(CODE);
  expect(stdin).toContain(FINGERPRINT);
  expect(stdin).toContain("runner serve --enroll-only --label 'worker-a'");
  expect(stdin).not.toContain("--connect");
  expect(stdin).toContain(remoteUnit(UNIT, "worker-a", "100.101.1.2:7411").trimEnd());
  expect(issued.count).toBe(1);
});

test("each script exit maps to its result code", async () => {
  const cases: [Partial<Ran>, string][] = [
    [{ code: 255, err: "ssh: connect to host worker-a port 22: Connection refused" }, "RUNNER_INSTALL_UNREACHABLE"],
    [{ code: 124, timedOut: true }, "RUNNER_INSTALL_UNREACHABLE"],
    [{ code: INSTALL_EXIT.noBun }, "RUNNER_INSTALL_NO_BUN"],
    [{ code: INSTALL_EXIT.notLinux }, "RUNNER_INSTALL_UNSUPPORTED"],
    [{ code: 1, err: "'sh' is not recognized as an internal or external command" }, "RUNNER_INSTALL_UNSUPPORTED"],
    [{ code: INSTALL_EXIT.noHerdr }, "RUNNER_INSTALL_NO_HERDR"],
    [{ code: INSTALL_EXIT.enroll, err: "RUNNER_ENROLL_REFUSED code used" }, "RUNNER_INSTALL_ENROLL_FAILED"],
    [{ code: INSTALL_EXIT.systemd, err: "Failed to connect to bus" }, "RUNNER_INSTALL_FAILED"],
    [{ code: 1, err: "mkdir: cannot create directory" }, "RUNNER_INSTALL_FAILED"],
  ];
  for (const [ran, code] of cases) {
    const { run } = fakeRun(ran);
    const result = await installRunner({ run, bundle: async () => BUNDLE, unitTemplate: UNIT, kind: posixKind }, request({ count: 0 }));
    expect(result.ok ? "ok" : result.code).toBe(code);
  }
});

test("bad inputs are refused before a code is issued or ssh runs", async () => {
  const { run, calls } = fakeRun();
  const issued = { count: 0 };
  const bad = await installRunner({ run, bundle: async () => BUNDLE, unitTemplate: UNIT, kind: posixKind }, { ...request(issued), listenAddress: "h:1; rm -rf ~" });
  expect(bad.ok).toBe(false);
  expect(calls).toHaveLength(0);
  expect(issued.count).toBe(0);
  expect(() => installScript("x\nDORI_RUNNER_EOF\ny", UNIT, "worker-a", "h:1", { code: CODE, fingerprint: FINGERPRINT })).toThrow("heredoc delimiter");
});

const LOGIN_DIR = "/opt/login&tools|x/bin";
const fakeHost = () => {
  const home = mkdtempSync(join(tmpdir(), "runner-install-home-"));
  dirs.push(home);
  const bin = join(home, "fakebin");
  mkdirSync(bin);
  const log = join(home, "argv.log");
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${log}'\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool("uname", "echo Linux");
  tool("bun", `[ "$1" = --version ] && { echo 1.3.0; exit 0; }; cat > '${join(home, "enroll-stdin")}'; mkdir -p "$HOME/.dori/runner/keys"; echo pinned > "$HOME/.dori/runner/keys/supervisor.pub"`);
  tool("loginctl", "exit 0");
  // The herdr unit is inactive and no herdr answers, unless a test says otherwise.
  tool("systemctl", `[ "$2" = is-active ] && exit 3; exit 0`);
  tool("herdr", "exit 1");
  // The login shell: its profile prints noise and adds a directory to PATH.
  tool("loginsh", `echo 'Welcome to worker-a'; PATH="${LOGIN_DIR}:$PATH" exec /bin/sh -c "$2"`);
  tool("id", "echo dori");
  return { home, bin, log, tool };
};

const PLIST = readFileSync(join(import.meta.dir, "..", "templates", "dori-runner-launchd.plist"), "utf8");
const SYSTEM_TOOLS = ["mkdir", "chmod", "cat", "mv", "rm", "sed", "mktemp", "unzip", "dirname", "cp", "sleep", "tail", "grep"];
/** A Darwin host whose PATH is only the fake bin, with the system tools the script needs linked into it. */
const darwinHost = (launchctl = "exit 0") => {
  const host = fakeHost();
  host.tool("uname", `case "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac`);
  host.tool("id", `[ "$1" = -u ] && echo 501 || echo dori`);
  host.tool("launchctl", launchctl);
  for (const name of SYSTEM_TOOLS) symlinkSync(Bun.which(name) as string, join(host.bin, name));
  return host;
};
const runDarwin = async (host: ReturnType<typeof fakeHost>, script: string) => {
  const p = Bun.spawn(["/bin/sh", "-s"], { stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe", env: { HOME: host.home, PATH: host.bin, SHELL: join(host.bin, "loginsh") } });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, err, out };
};
const darwinScript = () =>
  installScript(BUNDLE, UNIT, "worker-a", "100.101.1.2:7411", { code: CODE, fingerprint: FINGERPRINT }, remoteUnit(PLIST, "worker-a", "100.101.1.2:7411"), AGENT);
const ARGS = ["runner", "serve", "--label", "worker-a", "--listen", "100.101.1.2:7411"];

const runScript = async (host: ReturnType<typeof fakeHost>, script: string) => {
  const p = Bun.spawn(["/bin/sh", "-s"], {
    stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe",
    env: { HOME: host.home, PATH: `${host.bin}:/usr/bin:/bin`, SHELL: join(host.bin, "loginsh") },
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, err, out };
};

test("real runner enroll-only completes two SSH stdio passes without a supervisor listener, then install records the worker endpoint", async () => {
  const host = fakeHost();
  host.tool("bun", `exec '${process.execPath}' "$@"`);
  const req = request({ count: 0 });
  const auth = new SupervisorAuth(req.stateDir, { now: () => 1000 });
  const bundle = `import { runnerHostMain } from ${JSON.stringify(join(import.meta.dir, "../src/runner/main.ts"))};\nprocess.exit(await runnerHostMain(process.argv.slice(3)));\n`;
  const calls: Call[] = [];
  try {
    const result = await installRunner({
      run: async (argv, opts) => {
        calls.push({ argv, opts });
        expect(readRunnerEndpoints(req.stateDir)).toEqual({});
        return runScript(host, opts!.stdin!);
      },
      bundle: async () => bundle, kind: posixKind,
    }, {
      ...req, issue: () => ({ code: auth.issueCode(req.label).code, fingerprint: auth.fingerprint }),
      enroll: (body) => auth.enroll(body),
    });
    expect(result).toEqual({ ok: true, version: bundleVersion(bundle), herdr: "started" });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.argv.at(-1) === "sh -s")).toBe(true);
    expect(calls[0]!.opts!.stdin).not.toContain("reply=");
    expect(calls[1]!.opts!.stdin).toContain("reply=");
    const worker = new RunnerAuth(join(host.home, ".dori/runner"));
    expect(worker.supervisorKey()).toBe(auth.publicKey);
    expect(auth.key(req.label)?.pubKey).toBe(worker.keyPair().pub);
    expect(readRunnerEndpoints(req.stateDir)).toEqual({ "worker-a": req.listenAddress });
    const log = readFileSync(host.log, "utf8");
    expect(log.match(/systemctl --user restart --job-mode=ignore-dependencies dori-runner.service/g)).toHaveLength(1);
  } finally { auth.close(); }
});

test("Windows enrollment returns its proof on SSH stdout and receives the response only through stdin", async () => {
  const req = request({ count: 0 });
  const runnerDir = join(req.stateDir, "worker");
  mkdirSync(runnerDir, { mode: 0o700 });
  const auth = new SupervisorAuth(req.stateDir, { now: () => 1000 });
  const worker = new RunnerAuth(runnerDir);
  const code = auth.issueCode(req.label).code;
  const params = { auth: worker, code, label: req.label, hostId: "windows-host", expectedFingerprint: auth.fingerprint };
  const calls: Call[] = [];
  // Each Windows pass uploads the script with scp, then runs it over ssh with no stdin.
  const uploads: string[] = [];
  try {
    const result = await installRunner({
      run: async (argv, opts) => {
        calls.push({ argv, opts });
        if (argv[0] === "scp") { uploads.push(readFileSync(argv.at(-2)!, "utf8")); return { code: 0, out: "", err: "" }; }
        expect(opts?.stdin).toBeUndefined();
        const reply = /reply=([A-Za-z0-9+/=]+)/.exec(uploads.at(-1)!)?.[1];
        const request = enrollOverStdio(params, reply);
        return request ? { code: INSTALL_EXIT.enrollPending, out: `RUNNER_ENROLL_REQUEST ${request}\r\n`, err: "" } : { code: 0, out: "", err: "" };
      },
      bundle: async () => BUNDLE, kind: async () => ({ ok: true, kind: "windows" }),
    }, { ...req, issue: () => ({ code, fingerprint: auth.fingerprint }), enroll: (body) => auth.enroll(body) });
    expect(result).toMatchObject({ ok: true });
    expect(calls.map((call) => call.argv[0])).toEqual(["scp", "ssh", "scp", "ssh"]);
    expect(uploads[0]).not.toContain("$Enroll.StandardInput.Write('reply=");
    expect(uploads[1]).toContain("$Enroll.StandardInput.Write('reply=");
    expect(calls.flatMap((call) => call.argv).join(" ")).not.toContain(code);
    expect(worker.supervisorKey()).toBe(auth.publicKey);
  } finally { auth.close(); }
});

test("a malformed SSH enrollment request fails without recording an endpoint", async () => {
  const req = request({ count: 0 });
  const { run, calls } = fakeRun({ code: INSTALL_EXIT.enrollPending, out: "RUNNER_ENROLL_REQUEST garbage" });
  const result = await installRunner({ run, bundle: async () => BUNDLE, kind: posixKind }, req);
  expect(result).toMatchObject({ ok: false, code: "RUNNER_INSTALL_ENROLL_FAILED" });
  expect(calls).toHaveLength(1);
  expect(readRunnerEndpoints(req.stateDir)).toEqual({});
});

test("run by sh, the script installs, enrolls through a pipe, and keeps the keys on reinstall", async () => {
  const host = fakeHost();
  const script = installScript(BUNDLE, remoteUnit(UNIT, "worker-a", "100.101.1.2:7411"), "worker-a", "100.101.1.2:7411", { code: CODE, fingerprint: FINGERPRINT }, undefined, AGENT);
  const first = await runScript(host, script);
  expect(first).toEqual({ code: 0, err: "", out: "DORI_HERDR started\n" });
  const policyFile = join(host.home, ".dori/runner/runner-config.json");
  const wrapperPath = join(host.home, ".dori/runner/bin/lane-sandbox");
  expect(JSON.parse(readFileSync(policyFile, "utf8"))).toEqual({
    agents: { default: AGENT, sandboxed: [wrapperPath, ...AGENT] }, allowedRoots: [host.home, "/tmp"], sandbox: "required", sandboxCheck: [wrapperPath, "--check"],
  });
  expect(loadPolicy(join(host.home, ".dori/runner"))).toMatchObject({ sandbox: "required", sandboxCheck: [wrapperPath, "--check"] });
  expect(statSync(policyFile).mode & 0o777).toBe(0o600);
  expect(readFileSync(wrapperPath, "utf8")).toBe(readFileSync(LANE_SANDBOX_TEMPLATE, "utf8"));
  expect(statSync(wrapperPath).mode & 0o777).toBe(0o700);
  const argvLog = readFileSync(host.log, "utf8");
  expect(argvLog).not.toContain(CODE);
  expect(argvLog).not.toContain(FINGERPRINT);
  expect(argvLog).toContain("bun ");
  expect(argvLog).toContain("runner serve --enroll-only --label worker-a");
  expect(argvLog).toContain("systemctl --user restart --job-mode=ignore-dependencies dori-runner.service");
  expect(argvLog).toContain("loginctl enable-linger dori");
  expect(readFileSync(join(host.home, "enroll-stdin"), "utf8")).toBe(`code=${CODE}\nfingerprint=${FINGERPRINT}\n`);
  expect(readFileSync(join(host.home, ".dori/runner/bin/dori.js"), "utf8")).toBe(BUNDLE);
  const wrapper = join(host.home, ".dori/runner/bin/dori");
  expect(readFileSync(wrapper, "utf8")).toBe(`#!/bin/sh\nexec "${join(host.bin, "bun")}" "$HOME/.dori/runner/bin/dori.js" "$@"\n`);
  expect(statSync(wrapper).mode & 0o777).toBe(0o700);
  expect(statSync(join(host.home, ".dori/runner")).mode & 0o777).toBe(0o700);
  const unit = readFileSync(join(host.home, ".config/systemd/user/dori-runner.service"), "utf8");
  expect(unit).toContain(`ExecStart=${join(host.bin, "bun")} %h/.dori/runner/bin/dori.js runner serve --label worker-a --listen 100.101.1.2:7411`);
  expect(unit).not.toMatch(/@[A-Z]+@/);
  expect(existsSync(join(host.home, ".dori/runner/dori-runner.service.tmp"))).toBe(false);

  writeFileSync(host.log, "");
  writeFileSync(policyFile, '{"agents":{"mine":["claude"]}}\n', { mode: 0o600 });
  const again = await runScript(host, script);
  expect(again.code).toBe(0);
  expect(readFileSync(policyFile, "utf8")).toBe('{"agents":{"mine":["claude"]}}\n');
  expect(again.out).toContain(`RUNNER_CONFIG_SANDBOX_MISSING sandbox:required agents.sandboxed sandboxCheck in ${policyFile}; add them to sandbox lanes on this runner\n`);
  const second = readFileSync(host.log, "utf8");
  expect(second).not.toContain("--enroll-only");
  expect(second).toContain("systemctl --user restart --job-mode=ignore-dependencies dori-runner.service");
});

test("run by sh without bun on PATH, the script exits with the no-bun code", async () => {
  const host = fakeHost();
  rmSync(join(host.bin, "bun"));
  const script = installScript(BUNDLE, UNIT, "worker-a", "h:1", { code: CODE, fingerprint: FINGERPRINT });
  const p = Bun.spawn(["/bin/sh", "-s"], { stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe", env: { HOME: host.home, PATH: host.bin, SHELL: join(host.bin, "loginsh") } });
  expect(await p.exited).toBe(INSTALL_EXIT.noBun);
});

const programArguments = (plist: string): string[] =>
  [...(plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1] as string);
const plistPath = (home: string) => join(home, "Library/LaunchAgents/com.dori.runner.plist");

test("on Darwin with bun on PATH, the script writes the launchd agent, boots it into the gui domain, and enrolls through a pipe", async () => {
  const host = darwinHost();
  const script = darwinScript();
  expect(script).toContain('sed -e "s|@BUN@|$BUN|g" -e "s|@PATH@|$(xesc "$(dirname "$BUN"):$LP")|g"');
  expect(script).not.toContain('$(dirname "$BUN"):$PATH');
  const result = await runDarwin(host, script);
  expect(result).toEqual({ code: 0, err: "", out: "DORI_HERDR managed\n" });
  expect(loadPolicy(join(host.home, ".dori/runner")).allowedRoots).toEqual([host.home, "/private/tmp"]);
  const bun = join(host.bin, "bun");
  const plist = readFileSync(plistPath(host.home), "utf8");
  expect(plist).not.toMatch(/@[A-Z]+@/);
  expect(programArguments(plist)).toEqual([bun, join(host.home, ".dori/runner/bin/dori.js"), ...ARGS]);
  expect(plist).toContain(`<key>PATH</key>\n    <string>${host.bin}:/opt/login&amp;tools|x/bin:${host.bin}</string>`);
  expect(plist).toContain(`<string>${join(host.home, ".dori/runner/runner.log")}</string>`);
  expect(statSync(plistPath(host.home)).mode & 0o777).toBe(0o644);
  const domain = join(host.home, ".dori/runner/launchd-domain");
  expect(readFileSync(domain, "utf8")).toBe("gui/501\n");
  expect(statSync(domain).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(host.home, ".dori/runner/bin/dori"), "utf8")).toBe(`#!/bin/sh\nexec "${bun}" "$HOME/.dori/runner/bin/dori.js" "$@"\n`);
  const argvLog = readFileSync(host.log, "utf8");
  expect(argvLog).toContain(`launchctl bootstrap gui/501 ${plistPath(host.home)}`);
  expect(argvLog).toContain("launchctl enable gui/501/com.dori.runner");
  expect(argvLog).toContain("launchctl kickstart -k gui/501/com.dori.runner");
  expect(argvLog).not.toContain("systemctl");
  expect(argvLog).not.toContain("loginctl");
  expect(argvLog).not.toContain(CODE);
  expect(argvLog).not.toContain(FINGERPRINT);
  expect(argvLog).toContain("runner serve --enroll-only --label worker-a");
  expect(readFileSync(join(host.home, "enroll-stdin"), "utf8")).toBe(`code=${CODE}\nfingerprint=${FINGERPRINT}\n`);
  expect(existsSync(join(host.home, ".config"))).toBe(false);
  expect(existsSync(join(host.home, ".dori/runner/com.dori.runner.plist.tmp"))).toBe(false);
});

const CANDIDATES = ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"];
test.skipIf(!Bun.which("zip") || CANDIDATES.some((p) => existsSync(p)))("on Darwin with no bun anywhere, the script downloads the release zip into ~/.dori/runner/bun", async () => {
  const host = darwinHost();
  const stage = join(host.home, "stage");
  mkdirSync(join(stage, "bun-darwin-aarch64"), { recursive: true });
  copyFileSync(join(host.bin, "bun"), join(stage, "bun-darwin-aarch64/bun"));
  rmSync(join(host.bin, "bun"));
  const zip = Bun.spawn(["zip", "-qr", join(host.home, "fixture.zip"), "bun-darwin-aarch64"], { cwd: stage });
  expect(await zip.exited).toBe(0);
  host.tool("curl", `while [ $# -gt 0 ]; do [ "$1" = -o ] && O=$2; shift; done; cp '${join(host.home, "fixture.zip")}' "$O"`);
  const result = await runDarwin(host, darwinScript());
  expect(result).toMatchObject({ code: 0, err: "" });
  const bun = join(host.home, ".dori/runner/bun/bun");
  expect(statSync(bun).mode & 0o777).toBe(0o700);
  expect(readFileSync(host.log, "utf8")).toContain("curl -fsSL -o");
  expect(readFileSync(host.log, "utf8")).toContain("https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-aarch64.zip");
  const plist = readFileSync(plistPath(host.home), "utf8");
  expect(programArguments(plist)[0]).toBe(bun);
  expect(plist).toContain(`<string>${join(host.home, ".dori/runner/bun")}:/opt/login&amp;tools|x/bin:${host.bin}</string>`);
  expect(readFileSync(join(host.home, ".dori/runner/bin/dori"), "utf8")).toContain(`exec "${bun}"`);
  const left = new Bun.Glob("bun-download.*").scanSync({ cwd: join(host.home, ".dori/runner"), onlyFiles: false });
  expect([...left]).toEqual([]);
  checkRunnerDir(join(host.home, ".dori/runner"));
});

test("on Darwin a failing download exits with the no-bun code", async () => {
  const host = darwinHost();
  rmSync(join(host.bin, "bun"));
  host.tool("curl", "exit 22");
  const result = await runDarwin(host, darwinScript());
  expect(result.code).toBe(INSTALL_EXIT.noBun);
  expect(existsSync(plistPath(host.home))).toBe(false);
});

test("on Darwin without a gui domain, the script falls back to the user domain", async () => {
  const host = darwinHost(`[ "$1" = print ] && exit 113; exit 0`);
  const result = await runDarwin(host, darwinScript());
  expect(result).toMatchObject({ code: 0, err: "" });
  expect(readFileSync(join(host.home, ".dori/runner/launchd-domain"), "utf8")).toBe("user/501\n");
  const argvLog = readFileSync(host.log, "utf8");
  expect(argvLog).toContain(`launchctl bootstrap user/501 ${plistPath(host.home)}`);
  expect(argvLog).toContain("launchctl kickstart -k user/501/com.dori.runner");
});

test("on Darwin the agent is enabled before bootstrap, and a gui domain that refuses bootstrap falls back to the user domain", async () => {
  const host = darwinHost(`[ "$1" = bootstrap ] && [ "\${2%%/*}" = gui ] && exit 5; exit 0`);
  const result = await runDarwin(host, darwinScript());
  expect(result.code).toBe(0);
  expect(readFileSync(join(host.home, ".dori/runner/launchd-domain"), "utf8")).toBe("user/501\n");
  const lines = readFileSync(host.log, "utf8").split("\n").filter((l) => l.startsWith("launchctl "));
  expect(lines.filter((l) => l.startsWith("launchctl bootstrap gui/501 "))).toHaveLength(5);
  const enable = lines.indexOf("launchctl enable user/501/com.dori.runner");
  const bootstrap = lines.indexOf(`launchctl bootstrap user/501 ${plistPath(host.home)}`);
  expect(enable).toBeGreaterThanOrEqual(0);
  expect(bootstrap).toBeGreaterThan(enable);
  expect(lines.at(-1)).toBe("launchctl kickstart -k user/501/com.dori.runner");
});

test("on Darwin the script installs the seatbelt lane-sandbox and a starter policy that runs sandboxed lanes behind it", async () => {
  const host = darwinHost();
  const result = await runDarwin(host, darwinScript());
  expect(result.code).toBe(0);
  const policyFile = join(host.home, ".dori/runner/runner-config.json");
  const wrapperPath = join(host.home, ".dori/runner/bin/lane-sandbox");
  expect(JSON.parse(readFileSync(policyFile, "utf8"))).toEqual({
    agents: { default: AGENT, sandboxed: [wrapperPath, ...AGENT] }, allowedRoots: [host.home, "/private/tmp"], sandbox: "required", sandboxCheck: [wrapperPath, "--check"],
  });
  expect(loadPolicy(join(host.home, ".dori/runner"))).toMatchObject({ sandbox: "required", sandboxCheck: [wrapperPath, "--check"] });
  expect(readFileSync(wrapperPath, "utf8")).toBe(readFileSync(LANE_SANDBOX_MACOS_TEMPLATE, "utf8"));
  expect(readFileSync(wrapperPath, "utf8")).toContain('r "$H/.dori/runner/briefs/$key.files"');
  expect(readFileSync(wrapperPath, "utf8")).toContain('w "$H/.dori/runner/briefs/$key.out"');
  expect(readFileSync(wrapperPath, "utf8")).toContain('echo "DORI_LANE_FILES=1"');
  expect(statSync(wrapperPath).mode & 0o777).toBe(0o700);
  expect(result.out).not.toContain("RUNNER_CONFIG_SANDBOX_MISSING");
  // A reinstall over an operator's file names every key it lacks for sandboxed lanes, and leaves the file alone.
  writeFileSync(policyFile, '{"agents":{"default":["claude"]}}\n', { mode: 0o600 });
  const again = await runDarwin(host, darwinScript());
  expect(again.code).toBe(0);
  expect(again.out).toContain(`RUNNER_CONFIG_SANDBOX_MISSING sandbox:required agents.sandboxed sandboxCheck in ${policyFile}; add them to sandbox lanes on this runner\n`);
  expect(readFileSync(policyFile, "utf8")).toBe('{"agents":{"default":["claude"]}}\n');
});

test("a Linux reinstall over a complete sandbox policy prints no missing-key line; the generated script parses under sh -n", async () => {
  const host = fakeHost();
  expect((await runScript(host, linuxScript())).code).toBe(0);
  const wrapper = readFileSync(join(host.home, ".dori/runner/bin/lane-sandbox"), "utf8");
  expect(wrapper).toContain('--ro-bind "$H/.dori/runner/briefs/$key.files"');
  expect(wrapper).toContain('--bind "$H/.dori/runner/briefs/$key.out"');
  expect(wrapper).toContain('echo "DORI_LANE_FILES=1"');
  const again = await runScript(host, linuxScript());
  expect(again).toEqual({ code: 0, err: "", out: "DORI_HERDR started\n" });
  const p = Bun.spawn(["/bin/sh", "-n"], { stdin: new TextEncoder().encode(linuxScript()), stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
});

test("the lane-sandbox payload is checked against the heredoc delimiter too", () => {
  expect(() => installScript(BUNDLE, UNIT, "worker-a", "h:1", { code: CODE, fingerprint: FINGERPRINT }, "plist", [], { unit: "u", plist: "p" }, "a\nDORI_RUNNER_EOF\n")).toThrow("heredoc delimiter");
});

test("on any other OS the script exits with the unsupported code before touching anything", async () => {
  const host = fakeHost();
  host.tool("uname", "echo FreeBSD");
  const result = await runScript(host, darwinScript());
  expect(result.code).toBe(INSTALL_EXIT.notLinux);
  expect(existsSync(join(host.home, ".dori"))).toBe(false);
});

test("the runner directory the script leaves passes the runner's own safety check, on Linux and on Darwin", async () => {
  const linux = fakeHost();
  const linuxScript = installScript(BUNDLE, remoteUnit(UNIT, "worker-a", "h:1"), "worker-a", "h:1", { code: CODE, fingerprint: FINGERPRINT }, undefined, AGENT);
  expect((await runScript(linux, linuxScript)).code).toBe(0);
  checkRunnerDir(join(linux.home, ".dori/runner"));
  const darwin = darwinHost();
  mkdirSync(join(darwin.home, ".dori/runner"), { recursive: true, mode: 0o700 });
  writeFileSync(join(darwin.home, ".dori/runner/runner.log"), "old\n", { mode: 0o644 });
  expect((await runDarwin(darwin, darwinScript())).code).toBe(0);
  expect(statSync(join(darwin.home, ".dori/runner/runner.log")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(darwin.home, ".dori/runner/runner.log"), "utf8")).toBe("old\n");
  checkRunnerDir(join(darwin.home, ".dori/runner"));
});

test("the script creates ~/.dori/runner/evidence at 0700 and tightens an existing 0755 one, on Linux and on Darwin", async () => {
  for (const [makeHost, runIt, script] of [[fakeHost, runScript, linuxScript], [darwinHost, runDarwin, darwinScript]] as const) {
    const fresh = makeHost();
    expect((await runIt(fresh, script())).code).toBe(0);
    expect(statSync(join(fresh.home, ".dori/runner/evidence")).mode & 0o777).toBe(0o700);
    const loose = makeHost();
    mkdirSync(join(loose.home, ".dori/runner/evidence"), { recursive: true, mode: 0o700 });
    chmodSync(join(loose.home, ".dori/runner/evidence"), 0o755);
    expect((await runIt(loose, script())).code).toBe(0);
    expect(statSync(join(loose.home, ".dori/runner/evidence")).mode & 0o777).toBe(0o700);
    checkRunnerDir(join(loose.home, ".dori/runner"));
  }
});

test("the launchd plist is checked against the heredoc delimiter too", () => {
  expect(() => installScript(BUNDLE, UNIT, "worker-a", "h:1", { code: CODE, fingerprint: FINGERPRINT }, "a\nDORI_RUNNER_EOF\n")).toThrow("heredoc delimiter");
});

test("a bundle run outside any git checkout reports the git SHA it was built from", async () => {
  const sha = await gitVersion(realRun, import.meta.dir);
  expect(sha).toMatch(/^[0-9a-f]{7,}$/);
  const dir = mkdtempSync(join(tmpdir(), "dori-runner-version-"));
  dirs.push(dir);
  expect(await gitVersion(realRun, dir)).toBeUndefined();
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, `import { run } from ${JSON.stringify(join(import.meta.dir, "../src/run.ts"))};
import { runnerVersion } from ${JSON.stringify(join(import.meta.dir, "../src/runner/version.ts"))};
console.log((await runnerVersion(run, import.meta.dir)) ?? "-");\n`);
  const out = join(dir, "dori.js");
  writeFileSync(out, await buildBundle(realRun, entry)());
  const ran = await realRun(["bun", out], { timeoutMs: 30_000, cwd: dir });
  expect(ran.out.trim()).toBe(sha as string);
}, 60_000);

const herdrUnitPath = (home: string) => join(home, ".config/systemd/user/herdr-server.service");
const linuxScript = () => installScript(BUNDLE, remoteUnit(UNIT, "worker-a", "h:1"), "worker-a", "h:1", { code: CODE, fingerprint: FINGERPRINT }, undefined, AGENT);
const logLines = (log: string) => readFileSync(log, "utf8").split("\n");
/** Every call that could stop or restart a running herdr. */
const HERDR_DISRUPTION = /systemctl --user (restart|stop|kill|try-restart|reload-or-restart)[^\n]*herdr-server|launchctl (bootout|kickstart|kill|stop)[^\n]*com\.dori\.herdr|herdr server stop/;

test("the runner unit only Wants= and is After= the herdr unit, and the herdr unit carries no lead-host failure hook", () => {
  const runnerUnit = readFileSync(join(import.meta.dir, "..", "templates", "dori-runner-remote.service"), "utf8");
  expect(runnerUnit).toContain("\nWants=herdr-server.service\n");
  expect(runnerUnit).toContain("\nAfter=herdr-server.service\n");
  expect(runnerUnit).not.toMatch(/^(Requires|BindsTo|PartOf|Requisite)=/m);
  const herdrUnit = readFileSync(join(import.meta.dir, "..", "templates", "herdr-runner-remote.service"), "utf8");
  expect(herdrUnit).not.toContain("OnFailure=");
  expect(herdrUnit).toContain("ExecStart=@HERDR_BIN@ server\n");
  expect(herdrUnit).toContain("Restart=on-failure\n");
});

test("on Linux with no herdr answering, the script writes the herdr unit from the login shell and starts it before the runner", async () => {
  const host = fakeHost();
  const result = await runScript(host, linuxScript());
  expect(result).toEqual({ code: 0, err: "", out: "DORI_HERDR started\n" });
  const unit = readFileSync(herdrUnitPath(host.home), "utf8");
  expect(unit).toContain(`ExecStart=${join(host.bin, "herdr")} server\n`);
  expect(unit).toContain(`Environment=PATH=${LOGIN_DIR}:${host.bin}:/usr/bin:/bin\n`);
  expect(unit).toContain(`Environment=SHELL=${join(host.bin, "loginsh")}\n`);
  expect(unit).not.toMatch(/@[A-Z_]+@/);
  expect(statSync(herdrUnitPath(host.home)).mode & 0o777).toBe(0o644);
  expect(existsSync(join(host.home, ".dori/runner/herdr-server.service.tmp"))).toBe(false);
  const lines = logLines(host.log);
  const start = lines.indexOf("systemctl --user start herdr-server.service");
  expect(lines).toContain("systemctl --user enable herdr-server.service dori-runner.service");
  expect(start).toBeGreaterThan(lines.indexOf("systemctl --user daemon-reload"));
  expect(lines.indexOf("systemctl --user restart --job-mode=ignore-dependencies dori-runner.service")).toBeGreaterThan(start);
  expect(readFileSync(host.log, "utf8")).not.toMatch(HERDR_DISRUPTION);
  checkRunnerDir(join(host.home, ".dori/runner"));
});

test("on Linux a reinstall or upgrade leaves the herdr the unit runs alone and only rewrites the unit file", async () => {
  const host = fakeHost();
  expect((await runScript(host, linuxScript())).code).toBe(0);
  writeFileSync(herdrUnitPath(host.home), "old unit\n");
  writeFileSync(host.log, "");
  host.tool("systemctl", "exit 0");
  host.tool("herdr", `[ "$1" = workspace ] && exit 0; exit 1`);
  const again = await runScript(host, linuxScript());
  expect(again).toEqual({ code: 0, err: "", out: "DORI_HERDR managed\n" });
  expect(readFileSync(herdrUnitPath(host.home), "utf8")).toContain(`ExecStart=${join(host.bin, "herdr")} server\n`);
  const log = readFileSync(host.log, "utf8");
  expect(log).toContain("systemctl --user daemon-reload");
  expect(log).not.toContain("systemctl --user start herdr-server.service");
  expect(log).not.toContain("reset-failed");
  expect(log).not.toMatch(HERDR_DISRUPTION);
});

test("on Linux a herdr started by hand gets the unit enabled but not started", async () => {
  const host = fakeHost();
  host.tool("herdr", `[ "$1" = workspace ] && exit 0; exit 1`);
  const result = await runScript(host, linuxScript());
  expect(result).toEqual({ code: 0, err: "", out: "DORI_HERDR unmanaged\n" });
  const log = readFileSync(host.log, "utf8");
  expect(log).toContain("systemctl --user enable herdr-server.service dori-runner.service");
  expect(log).not.toContain("systemctl --user start herdr-server.service");
  // The runner restart does not pull the herdr unit in beside the hand-started server.
  expect(log).toContain("systemctl --user restart --job-mode=ignore-dependencies dori-runner.service");
  expect(log).not.toMatch(HERDR_DISRUPTION);
});

test("without herdr on the login PATH the script exits with the no-herdr code before writing anything", async () => {
  for (const [host, runIt] of [[fakeHost(), runScript], [darwinHost(), runDarwin]] as const) {
    rmSync(join(host.bin, "herdr"));
    expect((await runIt(host, runIt === runScript ? linuxScript() : darwinScript())).code).toBe(INSTALL_EXIT.noHerdr);
    expect(existsSync(join(host.home, ".dori"))).toBe(false);
    expect(existsSync(join(host.home, ".config"))).toBe(false);
    expect(existsSync(join(host.home, "Library"))).toBe(false);
  }
});

test("herdr found only on the login shell's PATH is accepted", async () => {
  const host = fakeHost();
  const loginBin = join(host.home, "login-bin");
  mkdirSync(loginBin);
  copyFileSync(join(host.bin, "herdr"), join(loginBin, "herdr"));
  chmodSync(join(loginBin, "herdr"), 0o755);
  rmSync(join(host.bin, "herdr"));
  host.tool("loginsh", `PATH="${loginBin}:$PATH" exec /bin/sh -c "$2"`);
  const result = await runScript(host, linuxScript());
  expect(result.code).toBe(0);
  expect(readFileSync(herdrUnitPath(host.home), "utf8")).toContain(`ExecStart=${join(loginBin, "herdr")} server\n`);
});

const herdrPlistPath = (home: string) => join(home, "Library/LaunchAgents/com.dori.herdr.plist");
const NOT_LOADED = `[ "$1" = print ] && case "$2" in */com.dori.herdr) exit 113 ;; esac; exit 0`;
const plistKey = (plist: string, key: string): string => plist.match(new RegExp(`<key>${key}</key>\\s*(<[^>]+>(?:[^<]*</[a-z]+>)?)`))?.[1] ?? "";

test("on Darwin with no herdr agent loaded, the script writes and bootstraps it into the runner's domain without kickstarting it", async () => {
  const host = darwinHost(NOT_LOADED);
  const result = await runDarwin(host, darwinScript());
  expect(result).toEqual({ code: 0, err: "", out: "DORI_HERDR started\n" });
  const plist = readFileSync(herdrPlistPath(host.home), "utf8");
  expect(plist).not.toMatch(/@[A-Z_]+@/);
  expect(programArguments(plist)).toEqual([join(host.bin, "herdr"), "server"]);
  expect(plistKey(plist, "RunAtLoad")).toBe("<true/>");
  expect(plistKey(plist, "KeepAlive")).toBe("<true/>");
  expect(plistKey(plist, "ThrottleInterval")).toBe("<integer>30</integer>");
  expect(plistKey(plist, "WorkingDirectory")).toBe(`<string>${host.home}</string>`);
  expect(plist).toContain(`<key>PATH</key>\n    <string>${LOGIN_DIR.replace("&", "&amp;")}:${host.bin}</string>`);
  expect(plist).toContain(`<key>SHELL</key>\n    <string>${join(host.bin, "loginsh")}</string>`);
  expect(plist).toContain(`<string>${join(host.home, ".dori/runner/herdr.log")}</string>`);
  expect(statSync(herdrPlistPath(host.home)).mode & 0o777).toBe(0o644);
  expect(statSync(join(host.home, ".dori/runner/herdr.log")).mode & 0o777).toBe(0o600);
  const lines = logLines(host.log);
  const enable = lines.indexOf("launchctl enable gui/501/com.dori.herdr");
  expect(enable).toBeGreaterThanOrEqual(0);
  expect(lines.indexOf(`launchctl bootstrap gui/501 ${herdrPlistPath(host.home)}`)).toBeGreaterThan(enable);
  expect(readFileSync(host.log, "utf8")).not.toMatch(HERDR_DISRUPTION);
  checkRunnerDir(join(host.home, ".dori/runner"));
});

test("on Darwin a herdr started by hand gets the agent with RunAtLoad false", async () => {
  const host = darwinHost(NOT_LOADED);
  host.tool("herdr", `[ "$1" = workspace ] && exit 0; exit 1`);
  const result = await runDarwin(host, darwinScript());
  expect(result).toEqual({ code: 0, err: "", out: "DORI_HERDR unmanaged\n" });
  const plist = readFileSync(herdrPlistPath(host.home), "utf8");
  expect(plistKey(plist, "RunAtLoad")).toBe("<false/>");
  expect(plistKey(plist, "ThrottleInterval")).toBe("<integer>30</integer>");
  expect(readFileSync(host.log, "utf8")).not.toMatch(HERDR_DISRUPTION);
});

test("on Darwin a reinstall or upgrade with the herdr agent loaded only rewrites its plist", async () => {
  const host = darwinHost();
  host.tool("herdr", `[ "$1" = workspace ] && exit 0; exit 1`);
  const result = await runDarwin(host, darwinScript());
  expect(result).toEqual({ code: 0, err: "", out: "DORI_HERDR managed\n" });
  expect(plistKey(readFileSync(herdrPlistPath(host.home), "utf8"), "RunAtLoad")).toBe("<true/>");
  const herdrCalls = logLines(host.log).filter((l) => l.startsWith("launchctl ") && l.includes("com.dori.herdr"));
  expect(herdrCalls).toEqual(["launchctl print gui/501/com.dori.herdr"]);
});

test("the script's DORI_HERDR line is the install result's herdr, named on the RUNNER_INSTALLED line", async () => {
  const { run } = fakeRun({ out: "enrolled\nDORI_HERDR unmanaged\n" });
  const result = await installRunner({ run, bundle: async () => BUNDLE, unitTemplate: UNIT, kind: posixKind }, request({ count: 0 }));
  expect(result).toEqual({ ok: true, version: bundleVersion(BUNDLE), herdr: "unmanaged" });
  expect(herdrInstallNote("unmanaged")).toBe("herdr=unmanaged (running, not from its unit; the unit takes over when it stops)");
  expect(herdrInstallNote(undefined)).toBe("herdr=unknown");
});

test("the herdr templates are checked against the heredoc delimiter too", () => {
  expect(() => installScript(BUNDLE, UNIT, "worker-a", "h:1", { code: CODE, fingerprint: FINGERPRINT }, "plist", [], { unit: "a\nDORI_RUNNER_EOF\n", plist: "p" })).toThrow("heredoc delimiter");
});
