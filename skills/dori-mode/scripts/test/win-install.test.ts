import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearShellModes, encodedPowerShell, sshArgv } from "../src/remote-guard.ts";
import { INSTALL_EXIT, INSTALL_TIMEOUT_MS, WIN_BUN, WIN_INSTALL_TIMEOUT_MS, bunPinDir, bunPinUrl, bundleVersion, installRunner, installScript, remoteUnit, scpArgv, windowsInstallScript, windowsTemplates, winRun } from "../src/runner/install.ts";
import type { Ran, RunOptions } from "../src/run.ts";

const CODE = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo";
const FINGERPRINT = "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const ISSUE = { code: CODE, fingerprint: FINGERPRINT };
// Non-ASCII on purpose: the script must still be pure ASCII.
const BUNDLE = "console.log('runner bundle \u00e9\u2014\u{1F680}');\n";
const LABEL = "win-a";
const LISTEN = "100.101.1.2:7411";
const AGENT = ["omo", "--model", "{model}", "\u00fcber {prompt}"];
const TEMPLATES = join(import.meta.dir, "..", "templates");
const machine = { label: LABEL, target: "dori@win-a" };

const dirs: string[] = [];
afterEach(() => { clearShellModes(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const script = () => windowsInstallScript(BUNDLE, LABEL, LISTEN, ISSUE, AGENT);
const decodePs = (command: string): string => {
  const m = /-EncodedCommand (\S+)$/.exec(command);
  if (!m?.[1]) throw new Error(`not an encoded command: ${command}`);
  return Buffer.from(m[1], "base64").toString("utf16le");
};
const payloads = (text: string): Map<string, string> =>
  new Map([...text.matchAll(/^Write-DoriFile '([^']+)' '([A-Za-z0-9+/=]*)'$/gm)].map((m) => [m[1] as string, Buffer.from(m[2] as string, "base64").toString("utf8")]));

test("the Windows install script is pure ASCII with LF lines", () => {
  const s = script();
  expect(/^[\x00-\x7f]*$/.test(s)).toBe(true);
  expect(s).not.toContain("\r");
});

test("the script ends with exit 0 and logs each step to the progress log in order", () => {
  const s = script();
  expect(s.split("\n").filter((line) => line !== "").at(-1)).toBe("exit 0");
  expect(s).toContain("'runner-install.log'");
  expect(s).toContain("[IO.File]::AppendAllText(");
  const steps = [...s.matchAll(/^Step '([a-z-]+)'$/gm)].map((m) => m[1]);
  expect(steps).toEqual(["start", "checks", "acl", "bun", "files", "stop-runner", "move", "config", "enroll", "task", "done"]);
});

test("winRun reads the uploaded file from the profile, deletes it, then runs it as a scriptblock", () => {
  const name = ".dori-runner-install-0123456789abcdef.ps1";
  expect(winRun(name)).toBe(`$ErrorActionPreference='Stop'; $f = Join-Path $env:USERPROFILE '${name}'; $s = [IO.File]::ReadAllText($f); Remove-Item -LiteralPath $f -Force; & ([scriptblock]::Create($s)); exit $LASTEXITCODE`);
  expect(scpArgv("u@h", "/tmp/x.ps1", name)).toEqual(["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "/tmp/x.ps1", `u@h:${name}`]);
});

test("every payload decodes to its input, the task XML with label and connect filled in", () => {
  const t = windowsTemplates();
  const got = payloads(script());
  expect(got).toEqual(new Map([
    ["dori.js", BUNDLE],
    ["dori.ps1", t.ps1],
    ["dori.cmd", t.cmd],
    ["dori", t.sh],
    ["runner-task.ps1", t.runnerTask],
    ["runner-sample.ps1", readFileSync(join(TEMPLATES, "runner-sample.ps1"), "utf8")],
    ["uninstall.ps1", t.uninstall],
    ["dori-runner-task.xml", remoteUnit(t.taskXml, LABEL, LISTEN)],
  ]));
  const xml = got.get("dori-runner-task.xml") ?? "";
  expect(xml).toContain(`-Label ${LABEL} -Listen ${LISTEN}`);
  // A headless console host runs the wrapper, so the logon task never opens a window.
  expect(xml).toContain("<Command>conhost.exe</Command>");
  expect(xml).toContain("<Arguments>--headless powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"@RUNNER@\\bin\\runner-task.ps1\" ");
  for (const want of ["<LogonType>InteractiveToken</LogonType>", "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>", "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>", "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>", "<StartWhenAvailable>true</StartWhenAvailable>",
    "<Interval>PT1M</Interval>", "<Count>999</Count>", "<LogonTrigger>"]) expect(xml).toContain(want);
  // Files are written beside their targets and moved in only after the bundle's hash checks out.
  const s = script();
  expect(s.indexOf("Move-DoriFile 'dori.js'")).toBeGreaterThan(s.indexOf("Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Bin 'dori.js.tmp')"));
});

test("the bundle is checked against its full SHA-256, whose first 12 hex are the version", () => {
  const full = createHash("sha256").update(BUNDLE).digest("hex");
  expect(script()).toContain(`if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Bin 'dori.js.tmp')).Hash.ToLowerInvariant() -ne '${full}') { Exit-Dori 1 `);
  expect(bundleVersion(BUNDLE)).toBe(full.slice(0, 12));
});

test("Bun is the pinned x64 build checked by hash, with the baseline build as the fallback", () => {
  const s = script();
  expect(WIN_BUN.x64.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(WIN_BUN.baseline.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(WIN_BUN.x64.asset).toBe("bun-windows-x64.zip");
  expect(WIN_BUN.baseline.asset).toBe("bun-windows-x64-baseline.zip");
  const x64 = `@{ Dir = '${WIN_BUN.x64.version}'; Asset = 'bun-windows-x64.zip'; Folder = 'bun-windows-x64'; Url = '${bunPinUrl(WIN_BUN.x64)}'; Sha256 = '${WIN_BUN.x64.sha256}' }`;
  const base = `@{ Dir = '${WIN_BUN.baseline.version}-baseline'; Asset = 'bun-windows-x64-baseline.zip'; Folder = 'bun-windows-x64-baseline'; Url = '${bunPinUrl(WIN_BUN.baseline)}'; Sha256 = '${WIN_BUN.baseline.sha256}' }`;
  expect(s).toContain(x64);
  expect(s).toContain(base);
  expect(s.indexOf(x64)).toBeLessThan(s.indexOf(base));
  expect(bunPinUrl(WIN_BUN.x64)).toBe(`https://github.com/oven-sh/bun/releases/download/bun-v${WIN_BUN.x64.version}/bun-windows-x64.zip`);
  expect(bunPinDir(WIN_BUN.baseline)).toBe(`${WIN_BUN.baseline.version}-baseline`);
  for (const want of ["Invoke-WebRequest -UseBasicParsing -Uri $Pin.Url -OutFile $Zip", "(Get-FileHash -Algorithm SHA256 -LiteralPath $Zip).Hash.ToLowerInvariant()",
    "if ($Got -ne $Pin.Sha256) { throw", "Expand-Archive -LiteralPath $Zip", "& $Exe --version", "if ($Exe -and (Test-DoriBun $Exe)) { $BunDir = $Pin.Dir; break }",
    `if (-not $BunDir) { Exit-Dori ${INSTALL_EXIT.noBun} `]) expect(s).toContain(want);
});

test("the directory gets the protected DACL, the starter policy and the task registration", () => {
  const s = script();
  expect(s).toContain("& icacls.exe $R /inheritance:r /grant:r ('*' + $Sid + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'");
  expect(s).toContain("& icacls.exe $R /setowner ('*' + $Sid) /T /C /Q");
  expect(s).toContain("(ConvertTo-Json $env:USERPROFILE) + ',' + (ConvertTo-Json $env:TEMP)");
  const agent = /FromBase64String\('([A-Za-z0-9+/=]+)'\)\)\n/.exec(s)?.[1] ?? "";
  expect(JSON.parse(Buffer.from(agent, "base64").toString("utf8"))).toEqual(AGENT);
  expect(s).toContain("Register-ScheduledTask -TaskPath '\\dori\\' -TaskName 'dori-runner' -Xml $Xml -Force");
  expect(s).toContain("Start-ScheduledTask -TaskPath '\\dori\\' -TaskName 'dori-runner'");
  expect(s).toContain(`} catch { Exit-Dori ${INSTALL_EXIT.systemd} `);
  expect(windowsInstallScript(BUNDLE, LABEL, LISTEN, ISSUE, [])).not.toContain("runner-config.json");
});

test("the enrollment secret goes to the enrolling process's stdin, never its arguments", () => {
  const s = script();
  expect(s).toContain(`$C = '${CODE}'`);
  expect(s).toContain(`$F = '${FINGERPRINT}'`);
  expect(s).toContain("$Enroll.StandardInput.Write('code=' + $C + [char]10 + 'fingerprint=' + $F + [char]10)");
  const args = s.split("\n").find((l) => l.includes("$Psi.Arguments")) ?? "";
  expect(args).toContain(`runner serve --enroll-only --label ' + '${LABEL}'`);
  expect(args).not.toContain("--connect");
  expect(args).not.toContain("--listen");
  expect(args).not.toContain("$C");
  expect(args).not.toContain(CODE);
  expect(s).toContain("if (-not (Test-Path -LiteralPath (Join-Path $R 'keys\\supervisor.pub'))) {");
});

// An scp call records the uploaded file's content as it was when scp ran.
type Call = { argv: readonly string[]; opts?: RunOptions; uploaded?: string };
const fakeRun = (answer: (command: string, argv: readonly string[]) => Partial<Ran>) => {
  const calls: Call[] = [];
  const run = async (argv: readonly string[], opts?: RunOptions): Promise<Ran> => {
    calls.push({ argv, ...(opts ? { opts } : {}), ...(argv[0] === "scp" ? { uploaded: readFileSync(argv.at(-2) ?? "", "utf8") } : {}) });
    return { code: 0, out: "", err: "", ...answer(argv.at(-1) ?? "", argv) } as Ran;
  };
  return { run, calls };
};
const REMOTE = /^.+:(\.dori-runner-install-[0-9a-f]{16}\.ps1)$/;
/** One Windows pass: scp uploads `want`, then ssh runs winRun on that same remote name with no stdin. */
const expectWinPass = (scp: Call | undefined, ssh: Call | undefined, want: string): void => {
  expect(scp?.argv[0]).toBe("scp");
  const remote = REMOTE.exec(scp?.argv.at(-1) ?? "")?.[1] ?? "";
  expect(remote).not.toBe("");
  expect(scp?.argv).toEqual(scpArgv(machine.target, scp?.argv.at(-2) ?? "", remote));
  expect(scp?.opts?.timeoutMs).toBe(INSTALL_TIMEOUT_MS);
  expect(scp?.uploaded).toBe(want);
  expect(ssh?.argv).toEqual(sshArgv(machine.target, encodedPowerShell(winRun(remote))));
  expect(decodePs(ssh?.argv.at(-1) ?? "")).toBe(winRun(remote));
  expect(ssh?.opts?.stdin).toBeUndefined();
  expect(ssh?.opts?.timeoutMs).toBe(WIN_INSTALL_TIMEOUT_MS);
};
const request = () => {
  const stateDir = mkdtempSync(join(tmpdir(), "win-install-state-"));
  dirs.push(stateDir);
  return { machine, label: LABEL, listenAddress: LISTEN, stateDir, agentCommand: AGENT, issue: () => ISSUE,
    enroll: () => { throw new Error("unexpected enrollment request"); } };
};
const deps = (run: ReturnType<typeof fakeRun>["run"], kind?: "posix" | "windows") => ({
  run, bundle: async () => BUNDLE, unitTemplate: "ExecStart=@BUN@\n",
  ...(kind ? { kind: async () => ({ ok: true as const, kind }) } : {}),
});
test("a Windows machine gets the script uploaded by scp and run from that file, and the secret only in the file", async () => {
  const { run, calls } = fakeRun(() => ({}));
  expect(await installRunner(deps(run, "windows"), request())).toEqual({ ok: true, version: bundleVersion(BUNDLE) });
  expect(calls).toHaveLength(2);
  expectWinPass(calls[0], calls[1], script());
  expect((calls[1]?.argv.at(-1) ?? "").length).toBeLessThan(8191);
  for (const call of calls) for (const arg of call.argv) { expect(arg).not.toContain(CODE); expect(arg).not.toContain(FINGERPRINT); }
  // The local copy and its directory are gone once installRunner returns.
  const local = calls[0]?.argv.at(-2) ?? "";
  expect(existsSync(local)).toBe(false);
  expect(existsSync(join(local, ".."))).toBe(false);
});

test("a failed upload maps like an ssh failure and skips the ssh step", async () => {
  const down = fakeRun((_c, argv) => (argv[0] === "scp" ? { code: 255, err: "ssh: connect to host win-a port 22: Connection timed out" } : {}));
  const r1 = await installRunner(deps(down.run, "windows"), request());
  expect(r1.ok ? "ok" : r1.code).toBe("RUNNER_INSTALL_UNREACHABLE");
  expect(down.calls.map((c) => c.argv[0])).toEqual(["scp"]);
  const denied = fakeRun((_c, argv) => (argv[0] === "scp" ? { code: 1, err: "scp: dest open: Permission denied" } : {}));
  const r2 = await installRunner(deps(denied.run, "windows"), request());
  expect(r2.ok ? "ok" : r2.code).toBe("RUNNER_INSTALL_FAILED");
  if (!r2.ok) expect(r2.detail.startsWith("scp:")).toBe(true);
  expect(denied.calls.map((c) => c.argv[0])).toEqual(["scp"]);
  expect(existsSync(denied.calls[0]?.argv.at(-2) ?? "")).toBe(false);
});

test("a Windows ssh timeout points at the progress log on the host", async () => {
  const { run } = fakeRun((_c, argv) => (argv[0] === "scp" ? {} : { code: 124, timedOut: true }));
  const result = await installRunner(deps(run, "windows"), request());
  expect(result.ok ? "ok" : result.code).toBe("RUNNER_INSTALL_UNREACHABLE");
  if (!result.ok) expect(result.detail).toContain("runner-install.log");
});

test("installRunner probes the machine kind and branches on it", async () => {
  // A PowerShell host: the sh probe is not recognized, the encoded PowerShell probe answers.
  const win = fakeRun((c) => (c.includes("DORI_POSIX") ? { code: 1, err: "'x' is not recognized as an internal or external command" } : c.startsWith("powershell") && decodePs(c).includes("DORI_PS_") ? { out: "DORI_PS_42\r\n" } : {}));
  expect((await installRunner(deps(win.run), request())).ok).toBe(true);
  expectWinPass(win.calls.at(-2), win.calls.at(-1), script());
  clearShellModes();
  // A Linux host: the sh probe answers and uname says Linux.
  const linux = fakeRun((c) => (c.includes("DORI_POSIX") ? { out: "DORI_POSIX_42\n" } : c === "uname -s" ? { out: "Linux\n" } : {}));
  expect((await installRunner(deps(linux.run), request())).ok).toBe(true);
  expect(linux.calls.map((c) => c.argv.at(-1))).toEqual([expect.stringContaining("DORI_POSIX"), "uname -s", "sh -s"]);
  clearShellModes();
  // Git Bash as the ssh shell: POSIX, but uname names MINGW, so the Windows install runs.
  const bash = fakeRun((c) => (c.includes("DORI_POSIX") ? { out: "DORI_POSIX_42\n" } : c === "uname -s" ? { out: "MINGW64_NT-10.0-19045\n" } : {}));
  expect((await installRunner(deps(bash.run), request())).ok).toBe(true);
  expectWinPass(bash.calls.at(-2), bash.calls.at(-1), script());
  clearShellModes();
  // No shell answers, or ssh fails: refused before a code is issued.
  let issued = 0;
  const none = fakeRun(() => ({ code: 1, err: "garbage" }));
  const r1 = await installRunner(deps(none.run), { ...request(), issue: () => { issued += 1; return ISSUE; } });
  expect(r1.ok ? "ok" : r1.code).toBe("RUNNER_INSTALL_UNSUPPORTED");
  clearShellModes();
  const down = fakeRun(() => ({ code: 255, err: "ssh: connect to host win-a port 22: Connection refused" }));
  const r2 = await installRunner(deps(down.run), { ...request(), issue: () => { issued += 1; return ISSUE; } });
  expect(r2.ok ? "ok" : r2.code).toBe("RUNNER_INSTALL_UNREACHABLE");
  expect(issued).toBe(0);
});

test("the POSIX script exits 8 on a Windows uname, and installRunner then retries the Windows install", async () => {
  expect(installScript(BUNDLE, "u", LABEL, LISTEN, ISSUE, "p", [], { unit: "", plist: "" })).toContain(`MINGW*|MSYS*|CYGWIN*) exit ${INSTALL_EXIT.windowsShell} ;;`);
  const { run, calls } = fakeRun((c) => (c === "sh -s" ? { code: INSTALL_EXIT.windowsShell } : {}));
  expect(await installRunner(deps(run, "posix"), request())).toEqual({ ok: true, version: bundleVersion(BUNDLE) });
  expect(calls).toHaveLength(3);
  expect(calls[0]?.argv).toEqual(sshArgv(machine.target, "sh -s"));
  expectWinPass(calls[1], calls[2], script());
});

test("each Windows script exit maps to its result code", async () => {
  const cases: [Partial<Ran>, string, string?][] = [
    [{ code: 255, err: "ssh: connect to host win-a port 22: Connection refused" }, "RUNNER_INSTALL_UNREACHABLE"],
    [{ code: 124, timedOut: true }, "RUNNER_INSTALL_UNREACHABLE"],
    [{ code: INSTALL_EXIT.notLinux, err: "unsupported Windows host: ARM64 build 22631" }, "RUNNER_INSTALL_UNSUPPORTED", "x64 Windows 10 1809"],
    [{ code: INSTALL_EXIT.noBun, err: "bun checksum mismatch" }, "RUNNER_INSTALL_NO_BUN", "pinned Windows build"],
    [{ code: INSTALL_EXIT.noHerdr }, "RUNNER_INSTALL_NO_HERDR"],
    [{ code: INSTALL_EXIT.enroll, err: "enrollment failed with exit 1" }, "RUNNER_INSTALL_ENROLL_FAILED"],
    // PowerShell's CLIXML progress records after the real error line are skipped.
    [{ code: INSTALL_EXIT.enroll, err: "RUNNER_DIR_UNSAFE bin\\dori owner\nenrollment failed with exit 1\n#< CLIXML\n<Objs Version=\"1.1.0.1\"><Obj S=\"progress\" RefId=\"0\"></Obj></Objs>" }, "RUNNER_INSTALL_ENROLL_FAILED", "enrollment failed with exit 1"],
    [{ code: INSTALL_EXIT.systemd, err: "task scheduler: Access is denied." }, "RUNNER_INSTALL_FAILED", "task scheduler"],
    // A PowerShell error naming an unknown command is a failure here, not an unsupported shell.
    [{ code: 1, err: "The term 'Expand-Archive' is not recognized as the name of a cmdlet" }, "RUNNER_INSTALL_FAILED"],
  ];
  for (const [ran, code, detail] of cases) {
    const { run } = fakeRun((_c, argv) => (argv[0] === "scp" ? {} : ran));
    const result = await installRunner(deps(run, "windows"), request());
    expect(result.ok ? "ok" : result.code).toBe(code);
    if (detail && !result.ok) expect(result.detail).toContain(detail);
  }
});
