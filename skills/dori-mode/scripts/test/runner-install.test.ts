import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_EXIT, bundleVersion, installRunner, installScript, remoteUnit } from "../src/runner/install.ts";
import type { Ran, RunOptions } from "../src/run.ts";

const CODE = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo";
const FINGERPRINT = "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const UNIT = "ExecStart=@BUN@ %h/.dori/runner/bin/dori.js runner serve --label @LABEL@ --connect @CONNECT@\nEnvironment=PATH=@PATH@\n";
const BUNDLE = "console.log('runner bundle');\n";
const machine = { label: "worker-a", target: "dori@worker-a" };
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
const request = (issued: { count: number }) => ({
  machine, label: "worker-a", connectUrl: "ws://100.101.1.2:7411",
  issue: () => { issued.count += 1; return { code: CODE, fingerprint: FINGERPRINT }; },
});

test("the enrollment code and fingerprint go only on stdin, never in an argv element", async () => {
  const { run, calls } = fakeRun();
  const issued = { count: 0 };
  const result = await installRunner({ run, bundle: async () => BUNDLE, unitTemplate: UNIT }, request(issued));
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
  expect(stdin).toContain("--label 'worker-a' --connect 'ws://100.101.1.2:7411'");
  expect(stdin).toContain(remoteUnit(UNIT, "worker-a", "ws://100.101.1.2:7411").trimEnd());
  expect(issued.count).toBe(1);
});

test("each script exit maps to its result code", async () => {
  const cases: [Partial<Ran>, string][] = [
    [{ code: 255, err: "ssh: connect to host worker-a port 22: Connection refused" }, "RUNNER_INSTALL_UNREACHABLE"],
    [{ code: 124, timedOut: true }, "RUNNER_INSTALL_UNREACHABLE"],
    [{ code: INSTALL_EXIT.noBun }, "RUNNER_INSTALL_NO_BUN"],
    [{ code: INSTALL_EXIT.notLinux }, "RUNNER_INSTALL_UNSUPPORTED"],
    [{ code: 1, err: "'sh' is not recognized as an internal or external command" }, "RUNNER_INSTALL_UNSUPPORTED"],
    [{ code: INSTALL_EXIT.enroll, err: "RUNNER_ENROLL_REFUSED code used" }, "RUNNER_INSTALL_ENROLL_FAILED"],
    [{ code: INSTALL_EXIT.systemd, err: "Failed to connect to bus" }, "RUNNER_INSTALL_FAILED"],
    [{ code: 1, err: "mkdir: cannot create directory" }, "RUNNER_INSTALL_FAILED"],
  ];
  for (const [ran, code] of cases) {
    const { run } = fakeRun(ran);
    const result = await installRunner({ run, bundle: async () => BUNDLE, unitTemplate: UNIT }, request({ count: 0 }));
    expect(result.ok ? "ok" : result.code).toBe(code);
  }
});

test("bad inputs are refused before a code is issued or ssh runs", async () => {
  const { run, calls } = fakeRun();
  const issued = { count: 0 };
  const bad = await installRunner({ run, bundle: async () => BUNDLE, unitTemplate: UNIT }, { ...request(issued), connectUrl: "ws://h:1; rm -rf ~" });
  expect(bad.ok).toBe(false);
  expect(calls).toHaveLength(0);
  expect(issued.count).toBe(0);
  expect(() => installScript("x\nDORI_RUNNER_EOF\ny", UNIT, "worker-a", "ws://h:1", { code: CODE, fingerprint: FINGERPRINT })).toThrow("heredoc delimiter");
});

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
  tool("bun", `cat > '${join(home, "enroll-stdin")}'; mkdir -p "$HOME/.dori/runner/keys"; echo pinned > "$HOME/.dori/runner/keys/supervisor.pub"`);
  tool("loginctl", "exit 0");
  tool("systemctl", "exit 0");
  tool("id", "echo dori");
  return { home, bin, log };
};

const runScript = async (host: ReturnType<typeof fakeHost>, script: string) => {
  const p = Bun.spawn(["/bin/sh", "-s"], {
    stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe",
    env: { HOME: host.home, PATH: `${host.bin}:/usr/bin:/bin` },
  });
  return { code: await p.exited, err: await new Response(p.stderr).text() };
};

test("run by sh, the script installs, enrolls through a pipe, and keeps the keys on reinstall", async () => {
  const host = fakeHost();
  const script = installScript(BUNDLE, remoteUnit(UNIT, "worker-a", "ws://100.101.1.2:7411"), "worker-a", "ws://100.101.1.2:7411", { code: CODE, fingerprint: FINGERPRINT });
  const first = await runScript(host, script);
  expect(first).toEqual({ code: 0, err: "" });
  const argvLog = readFileSync(host.log, "utf8");
  expect(argvLog).not.toContain(CODE);
  expect(argvLog).not.toContain(FINGERPRINT);
  expect(argvLog).toContain("bun ");
  expect(argvLog).toContain("runner serve --enroll-only --label worker-a --connect ws://100.101.1.2:7411");
  expect(argvLog).toContain("systemctl --user restart dori-runner.service");
  expect(argvLog).toContain("loginctl enable-linger dori");
  expect(readFileSync(join(host.home, "enroll-stdin"), "utf8")).toBe(`code=${CODE}\nfingerprint=${FINGERPRINT}\n`);
  expect(readFileSync(join(host.home, ".dori/runner/bin/dori.js"), "utf8")).toBe(BUNDLE);
  const wrapper = join(host.home, ".dori/runner/bin/dori");
  expect(readFileSync(wrapper, "utf8")).toBe(`#!/bin/sh\nexec "${join(host.bin, "bun")}" "$HOME/.dori/runner/bin/dori.js" "$@"\n`);
  expect(statSync(wrapper).mode & 0o777).toBe(0o700);
  expect(statSync(join(host.home, ".dori/runner")).mode & 0o777).toBe(0o700);
  const unit = readFileSync(join(host.home, ".config/systemd/user/dori-runner.service"), "utf8");
  expect(unit).toContain(`ExecStart=${join(host.bin, "bun")} %h/.dori/runner/bin/dori.js runner serve --label worker-a --connect ws://100.101.1.2:7411`);
  expect(unit).not.toMatch(/@[A-Z]+@/);
  expect(existsSync(join(host.home, ".dori/runner/dori-runner.service.tmp"))).toBe(false);

  writeFileSync(host.log, "");
  const again = await runScript(host, script);
  expect(again.code).toBe(0);
  const second = readFileSync(host.log, "utf8");
  expect(second).not.toContain("--enroll-only");
  expect(second).toContain("systemctl --user restart dori-runner.service");
});

test("run by sh without bun on PATH, the script exits with the no-bun code", async () => {
  const host = fakeHost();
  rmSync(join(host.bin, "bun"));
  const script = installScript(BUNDLE, UNIT, "worker-a", "ws://h:1", { code: CODE, fingerprint: FINGERPRINT });
  const p = Bun.spawn(["/bin/sh", "-s"], { stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe", env: { HOME: host.home, PATH: host.bin } });
  expect(await p.exited).toBe(INSTALL_EXIT.noBun);
});
