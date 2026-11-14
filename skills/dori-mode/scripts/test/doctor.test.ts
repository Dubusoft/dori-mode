import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultConfig, loadConfig } from "../src/config.ts";
import { type Check, configSources, type DoctorDeps, doctorExit, renderDoctor, runDoctor, runnerChecks, tokenFrom } from "../src/doctor.ts";
import { LANE_SANDBOX_MACOS_TEMPLATE, LANE_SANDBOX_TEMPLATE } from "../src/lane-sandbox-install.ts";
import { defaultRunnerDir, RUNNER_PATHS } from "../src/runner/fs-safety.ts";
import { gatewayView, writeGatewayStatus } from "../src/gateway-status.ts";
import { pendingLeadRestart } from "../src/lead-restart.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { Registry } from "../src/registry.ts";
import { WAKES_FILE } from "../src/store.ts";
import type { Ran } from "../src/run.ts";
import { fakeClock, withState } from "./fakes.ts";

const TOKEN = "secret-token-xyz";
const PATH = process.env.PATH;
const NOW = 1_800_000_000_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); process.env.PATH = PATH; });

const ok = (out = ""): Ran => ({ code: 0, out, err: "" });
/** A current wrapper's successful --check. */
const checked = (): Ran => ok("DORI_LANE_FILES=1\n");
const no = (out = "", code = 1): Ran => ({ code, out, err: "" });
const pane = JSON.stringify({ result: { panes: [{ pane_id: "lead:p1", workspace_id: "w" }] } });
const happyRun: Record<string, Ran> = {
  "systemctl --user is-enabled herdr-server.service": ok("enabled"),
  "systemctl --user is-active herdr-server.service": ok("active"),
  "systemctl --user is-enabled dori-supervisor.service": ok("enabled"),
  "systemctl --user is-active dori-supervisor.service": ok("active"),
  "systemctl --user is-enabled dori-runner.service": no("disabled"),
  "systemctl --user is-active dori-runner.service": no("inactive", 3),
  "systemctl --user is-enabled dori-presence.service": no("disabled"),
  "systemctl --user is-active dori-presence.service": no("inactive", 3),
  "pgrep -f (dori|cli\\.ts) presence": no(),
  "herdr workspace list": ok(JSON.stringify({ result: { workspaces: [{ label: "lanes", workspace_id: "w1" }] } })),
  "pgrep -f herdr server": ok("101"),
  "systemctl --user show dori-supervisor.service --property=WorkingDirectory --value": ok("/work"),
  "herdr pane list": ok(pane),
  "gh --version": ok("gh 2"), "gh auth status": ok(), "jq --version": ok("jq-1.7"), "bun --version": ok("1.4"),
};
const resp = (status: number, body: unknown) => ({ status, headers: {}, body: JSON.stringify(body) });
const happyHttp: Record<string, ReturnType<typeof resp>> = {
  "/users/@me": resp(200, { username: "Dori" }),
  "/users/@me/guilds": resp(200, [{ id: "200" }]),
  "/applications/@me": resp(200, { flags: 1 << 18 }),
  "/channels/500/messages?limit=1": resp(200, []),
  "/applications/100/guilds/200/commands": resp(200, [{ name: "quota" }, { name: "status" }]),
};

type Patch = { run?: Record<string, Ran>; http?: Record<string, ReturnType<typeof resp>>; gateway?: "live" | "none" | "stale" | "nocontent" | "down"; free?: number; deps?: Partial<DoctorDeps> };
const fixture = (patch: Patch = {}) => {
  const state = withState();
  cleanups.push(state.done);
  mkdirSync(join(state.dir, ".dori", "runner"), { recursive: true });
  chmodSync(join(state.dir, ".dori", "runner"), 0o700);
  chmodSync(join(state.dir, ".dori"), 0o700);
  // A healthy Linux host: the current wrapper installed, bwrap on PATH, --check passing.
  const wrapper = join(state.dir, ".local", "bin", "lane-sandbox");
  mkdirSync(join(state.dir, ".local", "bin"), { recursive: true });
  copyFileSync(LANE_SANDBOX_TEMPLATE, wrapper);
  const table = { ...happyRun, [`${wrapper} --check`]: checked(), [`env DORI_LANE_KEY=doctor-probe ${wrapper} --explain`]: ok("rw /tmp\n"), ...patch.run };
  const routes = { ...happyHttp, ...patch.http };
  const calls: string[] = [];
  const requests: HttpRequest[] = [];
  const clock = fakeClock(NOW);
  const run = async (argv: readonly string[]): Promise<Ran> => {
    const line = argv.join(" ");
    calls.push(line);
    if (argv[0] === "df") return ok(`Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 1 1 ${Math.round((patch.free ?? 100) * 1024 * 1024)} 1% /`);
    return table[line] ?? { code: 127, out: "", err: `unexpected ${line}` };
  };
  const http: Http = async (req) => {
    requests.push(req);
    return routes[req.url.replace("https://discord.com/api/v10", "")] ?? resp(404, {});
  };
  const g = patch.gateway ?? "live";
  if (g !== "none") {
    writeGatewayStatus(state.dir, {
      pid: 1, at: g === "stale" ? NOW - 120_000 : NOW - 3_000,
      connected: g !== "down", messageContent: g !== "nocontent",
    });
  }
  mkdirSync(join(state.dir, "memory", "system"), { recursive: true });
  writeFileSync(join(state.dir, "memory", "system", "human.md"), "## Open\n- one item\n");
  const deps: DoctorDeps = {
    run, http, clock, configPath: "/home/test/config.json", envPath: "/home/test/.dori/env", token: TOKEN, tokenSource: "file", exists: () => true, home: state.dir, platform: "linux", which: () => "/usr/bin/bwrap",
    config: {
      ...defaultConfig("/home/test"), stateDir: state.dir, leadCwd: state.dir, leadPane: "lead:p1", laneWorkspace: "w1",
      memoryCheck: { ...defaultConfig("/home/test").memoryCheck, repo: join(state.dir, "memory") },
      discordChannels: ["500"], decisionsChannel: "500", discord: { applicationId: "100", guildId: "200", ownerId: "300" },
    },
    ...patch.deps,
  };
  writeFileSync(join(state.dir, "runner-endpoints.json"), JSON.stringify({ worker: "100.101.1.2:7411" }));
  return { deps, calls, requests };
};
const find = (checks: readonly Check[], id: string): Check => {
  const hit = checks.find((c) => c.id === id);
  if (!hit) throw new Error(`no check ${id}: ${checks.map((c) => c.id).join(", ")}`);
  return hit;
};

test("a healthy machine is all OK, exits 0 and prints the summary line", async () => {
  const f = fixture();
  const checks = await runDoctor(f.deps);
  expect(checks.filter((c) => c.level !== "OK")).toEqual([]);
  expect(doctorExit(checks)).toBe(0);
  expect(renderDoctor(checks)).toContain(`DOCTOR ok=${checks.length} warn=0 fail=0`);
});

test("doctor only reads: no unit changes and Discord is GET only", async () => {
  const f = fixture();
  await runDoctor(f.deps);
  expect(f.calls.filter((c) => /^systemctl --user (enable|disable|start|stop|restart|daemon-reload)/.test(c) || /^kill /.test(c))).toEqual([]);
  expect(f.requests.length).toBeGreaterThan(0);
  expect(f.requests.every((r) => r.method === "GET")).toBe(true);
});

test("doctor warns when the installed lane sandbox differs from the template", async () => {
  const f = fixture();
  writeFileSync(join(f.deps.home, ".local", "bin", "lane-sandbox"), "old sandbox");
  const check = find(await runDoctor({ ...f.deps, run: async (argv) => (argv[1] === "--check" ? checked() : f.deps.run(argv, {})) }), "lane sandbox");
  expect(check).toMatchObject({ level: "WARN" });
  expect(check.detail).toContain("LANE_SANDBOX_OUTDATED");
});

test("doctor names the sensitive host paths a lane can read, probed through the installed wrapper", async () => {
  const f = fixture();
  const home = f.deps.home;
  const wrapper = join(home, ".local", "bin", "lane-sandbox");
  // A wrapper that hides nothing: the probe runs on the host as is.
  writeFileSync(wrapper, '#!/bin/sh\nif [ "$1" = --check ]; then echo DORI_LANE_FILES=1; exit 0; fi\nexec "$@"\n');
  chmodSync(wrapper, 0o755);
  for (const d of [".aws", ".ssh", ".config/gh", ".kube"]) mkdirSync(join(home, d), { recursive: true });
  for (const p of [".aws/credentials", ".ssh/id_rsa", ".ssh/id_rsa.pub", ".config/gh/hosts.yml"]) writeFileSync(join(home, p), "x");
  writeFileSync(join(home, ".netrc"), "");
  const backups = join(home, "backups");
  mkdirSync(backups);
  writeFileSync(join(backups, "snap"), "x");
  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `# backups\n${backups}\n`);
  const argvs: string[][] = [];
  const real = async (argv: readonly string[], opts?: { cwd?: string }): Promise<Ran> => {
    if (argv[0] !== "env") return f.deps.run(argv, {});
    argvs.push([...argv]);
    const child = Bun.spawn([...argv], { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
    return { code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() };
  };
  const check = find(await runDoctor({ ...f.deps, run: real }), "lane exposure");
  expect(argvs[0]?.slice(0, 3)).toEqual(["env", "DORI_LANE_KEY=doctor-probe", wrapper]);
  expect(check).toMatchObject({ level: "WARN", fix: expect.stringContaining("lane-sandbox-hide") });
  expect(check.detail).toContain("~/.aws");
  expect(check.detail).toContain("~/.ssh/id_rsa");
  expect(check.detail).toContain("~/backups");
  expect(check.detail).toContain("bound on purpose: ~/.config/gh");
  // Empty on the host (an empty file, an empty dir) or a public key: not probed.
  for (const no of ["~/.netrc", "~/.kube", "id_rsa.pub"]) expect(check.detail).not.toContain(no);

  // A wrapper under which the probe reads nothing: OK.
  writeFileSync(wrapper, '#!/bin/sh\nif [ "$1" = --check ]; then echo DORI_LANE_FILES=1; exit 0; fi\nexit 0\n');
  expect(find(await runDoctor({ ...f.deps, run: real }), "lane exposure")).toMatchObject({ level: "OK", detail: expect.stringContaining("none readable in a lane") });
});

test("doctor probes lane exposure through the shipped Linux template, whose lane input and output binds need existing sources", async () => {
  const f = fixture();
  const home = f.deps.home;
  copyFileSync(LANE_SANDBOX_TEMPLATE, join(home, ".local", "bin", "lane-sandbox"));
  chmodSync(join(home, ".local", "bin", "lane-sandbox"), 0o755);
  // Like bwrap, a --ro-bind or --bind whose source is missing fails the run; the command itself reads nothing.
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bwrap"), '#!/bin/sh\nprev=\nfor a do [ "$a" = -- ] && exit 0; case "$prev" in --ro-bind|--bind) [ -e "$a" ] || { echo "bwrap: Can\'t find source path $a: No such file or directory" >&2; exit 1; } ;; esac; prev=$a; done\nexit 0\n');
  chmodSync(join(bin, "bwrap"), 0o755);
  process.env.PATH = `${bin}:${PATH}`;
  mkdirSync(join(home, ".aws"));
  writeFileSync(join(home, ".aws", "credentials"), "x");
  const real = async (argv: readonly string[], opts?: { cwd?: string }): Promise<Ran> => {
    if (argv[0] !== "env" && argv[1] !== "--check") return f.deps.run(argv, {});
    const child = Bun.spawn([...argv], { cwd: opts?.cwd, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    return { code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() };
  };
  const checks = await runDoctor({ ...f.deps, run: real });
  expect(find(checks, "lane sandbox")).toMatchObject({ level: "OK" });
  expect(find(checks, "lane exposure")).toMatchObject({ level: "OK", detail: expect.stringContaining("none readable in a lane") });
  // The probe lane's directories do not outlive the run.
  for (const n of ["doctor-probe.files", "doctor-probe.out"]) expect(existsSync(join(defaultRunnerDir(home), "briefs", n))).toBe(false);
});

test("doctor shows what a lane may write and what it cannot see, read off the installed wrapper's --explain", async () => {
  const f = fixture();
  const home = f.deps.home;
  const wrapper = join(home, ".local", "bin", "lane-sandbox");
  const backups = join(home, "backups");
  mkdirSync(join(backups, "granted"), { recursive: true });
  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `${backups}\n`);
  const argvs: string[][] = [];
  const real = async (argv: readonly string[], opts?: { cwd?: string }): Promise<Ran> => {
    if (argv[0] !== "env") return f.deps.run(argv, {});
    argvs.push([...argv]);
    // A runner grant under a hidden path: the table binds it, then hides it again.
    const child = Bun.spawn([...argv], { cwd: opts?.cwd, env: { PATH: process.env.PATH, HOME: home, LANE_SANDBOX_RW: join(backups, "granted") }, stdout: "pipe", stderr: "pipe" });
    return { code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() };
  };
  const check = find(await runDoctor({ ...f.deps, run: real }), "lane permissions");
  expect(argvs).toContainEqual(["env", "DORI_LANE_KEY=doctor-probe", wrapper, "--explain"]);
  expect(check.level).toBe("OK");
  expect(check.detail).toMatch(/^writable: [^;]*~\/\.cache[^;]*; hidden: [^;]*~\/\.dori\/runner[^;]*~\/backups[^;]*; each lane adds /);
  // Hidden after it is bound, so not writable.
  expect(check.detail).not.toContain("~/backups/granted");
  expect(check.detail).toContain(`${wrapper} --explain`);

  const failing = async (argv: readonly string[]): Promise<Ran> => (argv.at(-1) === "--explain" ? { code: 2, out: "", err: "usage: lane-sandbox\n" } : f.deps.run(argv, {}));
  expect(find(await runDoctor({ ...f.deps, run: failing }), "lane permissions")).toMatchObject({ level: "WARN", detail: `${wrapper} --explain failed: usage: lane-sandbox` });
});

test("doctor warns about $HOME dot entries and ~/.dori entries a lane can read that dori does not know, unless hidden", async () => {
  const f = fixture();
  const home = f.deps.home;
  expect(find(await runDoctor(f.deps), "lane home entries")).toMatchObject({ level: "OK" });

  // Known: a shell file, a credential store (hidden by the sandbox), dori's own entries and its credential stores.
  for (const d of [".aws", ".config/gcloud", ".dori/research", ".dori/state", ".dori/lead"]) mkdirSync(join(home, d), { recursive: true });
  for (const p of [".zshrc", ".netrc", ".dori/env", ".dori/config.json"]) writeFileSync(join(home, p), "x");
  expect(find(await runDoctor(f.deps), "lane home entries")).toMatchObject({ level: "OK" });

  // Unknown: a new tool's dot dir, a stray file next to dori's env, and a hidden entry only once it is in the hide list.
  mkdirSync(join(home, ".newtool"), { recursive: true });
  mkdirSync(join(home, ".private"), { recursive: true });
  for (const p of [".dori/env.bak", ".dori/notes", "plain-file"]) writeFileSync(join(home, p), "x");
  writeFileSync(join(home, ".dori", "lane-sandbox-hide"), `# owner's list\n${join(home, ".private")}\n`);
  const check = find(await runDoctor(f.deps), "lane home entries");
  expect(check).toMatchObject({ level: "WARN", detail: "a lane can read ~/.dori/env.bak, ~/.dori/notes, ~/.newtool, which dori does not know; check that none holds a credential", fix: expect.stringContaining("~/.dori/lane-sandbox-hide") });
  expect(doctorExit(await runDoctor(f.deps))).toBe(0);

  // No lane sandbox on Windows, so nothing to check there.
  expect((await runDoctor({ ...f.deps, platform: "win32" })).find((c) => c.id === "lane home entries")).toBeUndefined();
});

test("doctor fails a wrapper whose --check passes without the lane-files marker: the runner refuses its sandboxed lanes", async () => {
  const f = fixture();
  const check = find(await runDoctor({ ...f.deps, run: async (argv) => (argv[1] === "--check" ? ok() : f.deps.run(argv, {})) }), "lane sandbox");
  expect(check).toMatchObject({ level: "FAIL", detail: expect.stringContaining("LANE_FILES_SANDBOX_OLD"), fix: expect.stringContaining("dori update") });
});

test("doctor fails when the lane-sandbox wrapper is not installed", async () => {
  const f = fixture();
  rmSync(join(f.deps.home, ".local", "bin", "lane-sandbox"));
  const checks = await runDoctor(f.deps);
  expect(find(checks, "lane sandbox")).toMatchObject({ level: "FAIL", detail: expect.stringContaining("SANDBOX_MISSING"), fix: expect.stringContaining("dori update") });
  expect(doctorExit(checks)).toBe(1);
});

test("doctor fails when bwrap is not on PATH", async () => {
  const f = fixture({ deps: { which: () => undefined } });
  const checks = await runDoctor(f.deps);
  expect(find(checks, "lane sandbox")).toMatchObject({ level: "FAIL", detail: expect.stringContaining("bwrap is not on PATH") });
  expect(doctorExit(checks)).toBe(1);
});

test("doctor fails with the wrapper's stderr when lane-sandbox --check fails", async () => {
  const f = fixture();
  const wrapper = join(f.deps.home, ".local", "bin", "lane-sandbox");
  const check = find(await runDoctor({ ...f.deps, run: async (argv) => (argv[1] === "--check" ? { code: 3, out: "", err: "lane-sandbox: bwrap cannot create a sandbox\n" } : f.deps.run(argv, {})) }), "lane sandbox");
  expect(check).toMatchObject({ level: "FAIL", detail: expect.stringContaining(`${wrapper} --check failed: lane-sandbox: bwrap cannot create a sandbox`) });
});

test("on a Linux worker runner host doctor checks the wrapper dori runner install put in the runner's bin", async () => {
  const f = fixture();
  const runnerDir = defaultRunnerDir(f.deps.home);
  writeFileSync(join(runnerDir, RUNNER_PATHS.identity), JSON.stringify({ label: "worker" }));
  rmSync(join(f.deps.home, ".local", "bin", "lane-sandbox"));
  expect(find(await runDoctor(f.deps), "lane sandbox")).toMatchObject({ level: "FAIL", detail: expect.stringContaining(join(runnerDir, "bin", "lane-sandbox")), fix: expect.stringContaining("dori runner install") });
  mkdirSync(join(runnerDir, "bin"), { recursive: true });
  copyFileSync(LANE_SANDBOX_TEMPLATE, join(runnerDir, "bin", "lane-sandbox"));
  const run = async (argv: readonly string[]) => (argv.join(" ") === `${join(runnerDir, "bin", "lane-sandbox")} --check` ? checked() : f.deps.run(argv, {}));
  expect(find(await runDoctor({ ...f.deps, run }), "lane sandbox")).toMatchObject({ level: "OK" });
});

test("on a macOS worker runner host doctor checks the seatbelt wrapper in the runner's bin, without bwrap", async () => {
  const f = fixture({ deps: { platform: "darwin", which: () => undefined } });
  const runnerDir = defaultRunnerDir(f.deps.home);
  const wrapper = join(runnerDir, "bin", "lane-sandbox");
  writeFileSync(join(runnerDir, RUNNER_PATHS.identity), JSON.stringify({ label: "mini" }));
  expect(find(await runDoctor(f.deps), "lane sandbox")).toMatchObject({ level: "FAIL", detail: expect.stringContaining(wrapper), fix: expect.stringContaining("dori runner install") });
  mkdirSync(join(runnerDir, "bin"), { recursive: true });
  copyFileSync(LANE_SANDBOX_MACOS_TEMPLATE, wrapper);
  const run = async (argv: readonly string[]) => (argv.join(" ") === `${wrapper} --check` ? checked() : f.deps.run(argv, {}));
  expect(find(await runDoctor({ ...f.deps, run }), "lane sandbox")).toMatchObject({ level: "OK", detail: expect.stringContaining("seatbelt") });
  // The Linux wrapper on a Mac is outdated, not current.
  copyFileSync(LANE_SANDBOX_TEMPLATE, wrapper);
  expect(find(await runDoctor({ ...f.deps, run }), "lane sandbox")).toMatchObject({ level: "WARN", detail: expect.stringContaining("templates/lane-sandbox-macos.sh (LANE_SANDBOX_OUTDATED)"), fix: expect.stringContaining("dori runner install") });
});

test("doctor warns, without failing, that a Windows host's lanes run without a sandbox", async () => {
  const f = fixture({ deps: { platform: "win32", which: () => undefined } });
  rmSync(join(f.deps.home, ".local", "bin", "lane-sandbox"));
  const check = find(await runDoctor(f.deps), "lane sandbox");
  expect(check).toMatchObject({ level: "WARN", detail: expect.stringContaining("Windows has no lane sandbox") });
});

test("doctor names each runner opted into lanes without a sandbox", async () => {
  const f = fixture({});
  const checks = runnerChecks({ ...f.deps, config: { ...f.deps.config, runners: { mini: { allowUnsandboxed: true }, box: {} } } });
  expect(checks.find((c) => c.id === "runner mini sandbox")).toMatchObject({ level: "WARN", detail: expect.stringContaining("runner mini is opted in with runners.mini.allowUnsandboxed, so its lanes run WITHOUT a sandbox") });
  expect(checks.find((c) => c.id === "runner box sandbox")).toBeUndefined();
});

test("doctor warns when the obsolete local runner unit is enabled", async () => {
  const f = fixture({ run: { "systemctl --user is-enabled dori-runner.service": ok("enabled") } });
  expect(find(await runDoctor(f.deps), "runner unit")).toMatchObject({ level: "WARN", detail: expect.stringContaining("supervisor runs the local runner itself") });
});

test("doctor warns only when standalone guard agent files remain", async () => {
  const f = fixture();
  expect((await runDoctor(f.deps)).find((c) => c.id === "guard agent")).toBeUndefined();
  const path = join(f.deps.home, ".dori", "guard-agent.sh");
  writeFileSync(path, "legacy");
  expect(find(await runDoctor(f.deps), "guard agent")).toMatchObject({
    level: "WARN",
    detail: expect.stringContaining("guard-agent.sh left from the old standalone guard agent; the runner reports this host now"),
    fix: "the runner removes them when it starts (dori update on the lead restarts runners); or delete them",
  });
});

test("doctor warns when a lead restart is pending without consuming it or touching the warm lead", async () => {
  const f = fixture();
  const request = { id: "restart-doctor-177", at: NOW, models: [{ model: "qa/lead", thinking: "high" }, { model: "qa/fallback" }] };
  writeFileSync(join(f.deps.config.stateDir, "lead-restart.json"), JSON.stringify(request));
  const checks = await runDoctor(f.deps);
  const check = find(checks, "lead restart");
  expect(check.level).toBe("WARN");
  for (const value of [request.id, "qa/lead", "high", "qa/fallback"]) expect(check.detail).toContain(value);
  expect(doctorExit(checks)).toBe(0);
  expect(pendingLeadRestart(f.deps.config.stateDir)).toEqual(request);
  expect(f.calls).toEqual(expect.arrayContaining(["herdr pane list"]));
  expect(f.calls.filter((c) => c.startsWith("herdr ") && c !== "herdr pane list" && c !== "herdr workspace list")).toEqual([]);
});

test("doctor warns when lead wakes not from owner messages exceed the 24-hour threshold, naming their top trigger", async () => {
  const f = fixture();
  const wakes = (trigger: string[], n: number, from: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ at: NOW - from - i, session: "lead", trigger, kinds: {} }));
  const path = join(f.deps.config.stateDir, WAKES_FILE);
  writeFileSync(path, wakes(["INBOUND"], 25, 0).join("\n"));
  expect((await runDoctor(f.deps)).some((check) => check.id === "lead wakes")).toBe(false);
  writeFileSync(path, [...wakes(["INBOUND"], 25, 0), ...wakes(["HOST_GUARD OFFLINE"], 15, 100), ...wakes(["LANE_REPORT"], 6, 200)].join("\n"));
  const check = find(await runDoctor(f.deps), "lead wakes");
  expect(check).toMatchObject({
    level: "WARN", detail: "21 lead wakes not from owner messages in the last 24 hours (threshold 20; lane 6, noise 15); most from HOST_GUARD OFFLINE (15)",
  });
  expect(doctorExit([check])).toBe(0);
});

test("an inactive supervisor is FAIL with the enable command and exit 1; not-found points at setup", async () => {
  const down = fixture({ run: { "systemctl --user is-active dori-supervisor.service": no("inactive", 3) } });
  const checks = await runDoctor(down.deps);
  expect(find(checks, "unit dori-supervisor")).toMatchObject({ level: "FAIL", fix: "systemctl --user enable --now dori-supervisor.service" });
  expect(doctorExit(checks)).toBe(1);
  const missing = fixture({ run: { "systemctl --user is-enabled herdr-server.service": no("not-found", 4) } });
  expect(find(await runDoctor(missing.deps), "unit herdr-server")).toMatchObject({ level: "FAIL", fix: "dori setup --autostart" });
});

test("a legacy presence unit or a stray process is WARN (exit stays 0) with its own fix", async () => {
  const unit = fixture({ run: { "systemctl --user is-enabled dori-presence.service": ok("enabled"), "systemctl --user is-active dori-presence.service": ok("active") } });
  const a = await runDoctor(unit.deps);
  expect(find(a, "legacy presence")).toMatchObject({ level: "WARN", fix: "systemctl --user disable --now dori-presence.service" });
  expect(doctorExit(a)).toBe(0);
  const proc = fixture({ run: { "pgrep -f (dori|cli\\.ts) presence": ok("4242") } });
  const b = await runDoctor(proc.deps);
  expect(find(b, "legacy presence")).toMatchObject({ level: "WARN", fix: "kill 4242" });
  expect(doctorExit(b)).toBe(0);
});

test("herdr: unreachable and duplicate servers are FAIL", async () => {
  const down = fixture({ run: { "herdr workspace list": no("", 1) } });
  expect(find(await runDoctor(down.deps), "herdr")).toMatchObject({ level: "FAIL", fix: "systemctl --user start herdr-server.service" });
  const dup = fixture({ run: { "pgrep -f herdr server": ok("101\n202") } });
  expect(find(await runDoctor(dup.deps), "herdr")).toMatchObject({ level: "FAIL", detail: "2 herdr server processes" });
});

test("herdr unreachable on a worker machine points at the lead host's runner herdr command, or at install without a herdr unit", async () => {
  const f = fixture({ run: { "herdr workspace list": no("", 1) } });
  writeFileSync(join(f.deps.home, ".dori", "runner", "runner.json"), JSON.stringify({ id: "i", label: "worker-a", hostId: "h" }));
  expect(find(await runDoctor(f.deps), "herdr")).toMatchObject({ level: "FAIL", fix: "on the lead host: dori runner herdr start --machine worker-a" });
  const bare = { ...f.deps, exists: (path: string) => !path.endsWith("herdr-server.service") && !path.endsWith("com.dori.herdr.plist") };
  expect(find(await runDoctor(bare), "herdr")).toMatchObject({ level: "FAIL", fix: "on the lead host: dori runner install --machine worker-a (installs the herdr unit)" });
  // The lead host's local runner is labelled local: its own unit stays the fix.
  writeFileSync(join(f.deps.home, ".dori", "runner", "runner.json"), JSON.stringify({ id: "i", label: "local", hostId: "h" }));
  expect(find(await runDoctor(f.deps), "herdr")).toMatchObject({ level: "FAIL", fix: "systemctl --user start herdr-server.service" });
});

test("missing WorkingDirectory, missing dirs, missing config keys and a missing lead pane are FAIL", async () => {
  const wd = fixture({ run: { "systemctl --user show dori-supervisor.service --property=WorkingDirectory --value": ok("") } });
  expect(find(await runDoctor(wd.deps), "supervisor WorkingDirectory").detail).toContain("200/CHDIR");
  const dirs = fixture({ deps: { exists: (p) => p === "/work" } });
  const c = await runDoctor(dirs.deps);
  expect(find(c, "stateDir")).toMatchObject({ level: "FAIL" });
  expect(find(c, "leadCwd").fix).toStartWith("mkdir -p ");
  const keys = fixture({ deps: { config: { ...fixture().deps.config, laneWorkspace: "", discordChannels: [], discord: { applicationId: "x", guildId: "200", ownerId: "300" } } } });
  const kc = await runDoctor(keys.deps);
  const k = find(kc, "config");
  expect(k.level).toBe("FAIL");
  expect(find(kc, "lanes workspace")).toMatchObject({ level: "WARN", fix: "systemctl --user restart dori-supervisor.service" });
  expect(k.detail).toContain("discordChannels");
  expect(k.detail).toContain("discord.applicationId");
  const lead = fixture({ run: { "herdr pane list": ok(JSON.stringify({ result: { panes: [] } })) } });
  expect(find(await runDoctor(lead.deps), "leadPane")).toMatchObject({ level: "FAIL", fix: "dori lead-restart" });
  const gone = fixture({ run: { "herdr workspace list": ok(JSON.stringify({ result: { workspaces: [{ label: "lanes", workspace_id: "w9" }] } })) } });
  expect(find(await runDoctor(gone.deps), "lanes workspace")).toMatchObject({ level: "WARN" });
  const bad = fixture({ deps: { configError: "Unexpected token" } });
  expect(find(await runDoctor(bad.deps), "config")).toMatchObject({ level: "FAIL" });
});

test("a set but blank leadModel or leadThinking is WARN; set or absent says nothing", async () => {
  const config = fixture().deps.config;
  const blank = find(await runDoctor(fixture({ deps: { config: { ...config, leadModel: " ", leadThinking: "high" } } }).deps), "lead command");
  expect(blank).toMatchObject({ level: "WARN" });
  expect(blank.detail).toStartWith("leadModel set but blank");
  const set = await runDoctor(fixture({ deps: { config: { ...config, leadModel: "m/lead", leadThinking: "high" } } }).deps);
  expect(set.find((c) => c.id === "lead command")).toBeUndefined();
});

test("token: rejected is FAIL, absent is FAIL with no Discord call, env-only is WARN; it is never printed", async () => {
  const rejected = fixture({ http: { "/users/@me": resp(401, { message: "401: Unauthorized" }) } });
  const a = await runDoctor(rejected.deps);
  expect(find(a, "discord token")).toMatchObject({ level: "FAIL", detail: "token rejected (401)" });
  expect(a.find((c) => c.id === "bot in guild")).toBeUndefined();
  const none = fixture({ deps: { token: undefined, tokenSource: undefined } });
  const b = await runDoctor(none.deps);
  expect(find(b, "discord token").level).toBe("FAIL");
  expect(none.requests).toHaveLength(0);
  const env = fixture({ deps: { tokenSource: "env" } });
  const c = await runDoctor(env.deps);
  expect(find(c, "discord token").level).toBe("WARN");
  for (const checks of [a, b, c]) expect(renderDoctor(checks)).not.toContain(TOKEN);
  const ok1 = fixture();
  expect(renderDoctor(await runDoctor(ok1.deps))).not.toContain(TOKEN);
  expect(ok1.requests.every((r) => r.headers?.Authorization === `Bot ${TOKEN}`)).toBe(true);
});

test("bot outside the guild and unreadable channels are FAIL", async () => {
  const f = fixture({ http: { "/users/@me/guilds": resp(200, [{ id: "999" }]), "/channels/500/messages?limit=1": resp(403, {}) } });
  const checks = await runDoctor(f.deps);
  expect(find(checks, "bot in guild").level).toBe("FAIL");
  expect(find(checks, "channels")).toMatchObject({ level: "FAIL", detail: "500: no access" });
});

test("Message Content intent: either flag is OK, none is WARN with the Developer Portal step", async () => {
  expect(find(await runDoctor(fixture({ http: { "/applications/@me": resp(200, { flags: 1 << 19 }) } }).deps), "message content intent").level).toBe("OK");
  const f = fixture({ http: { "/applications/@me": resp(200, { flags: 0 }) } });
  const checks = await runDoctor(f.deps);
  expect(find(checks, "message content intent")).toMatchObject({ level: "WARN" });
  expect(find(checks, "message content intent").fix).toContain("Developer Portal");
  expect(doctorExit(checks)).toBe(0);
});

test("slash commands: a missing /status or /quota is WARN with the restart fix", async () => {
  const f = fixture({ http: { "/applications/100/guilds/200/commands": resp(200, [{ name: "quota" }]) } });
  expect(find(await runDoctor(f.deps), "slash commands")).toMatchObject({ level: "WARN", detail: "not registered: /status", fix: "systemctl --user restart dori-supervisor.service" });
  const none = fixture({ http: { "/applications/100/guilds/200/commands": resp(200, []) } });
  expect(find(await runDoctor(none.deps), "slash commands").detail).toBe("not registered: /quota, /status");
});

test("gateway: live OK; no file, stale and disconnected FAIL; without Message Content WARN", async () => {
  expect(find(await runDoctor(fixture({ gateway: "live" }).deps), "gateway").level).toBe("OK");
  for (const g of ["none", "stale", "down"] as const) expect(find(await runDoctor(fixture({ gateway: g }).deps), "gateway")).toMatchObject({ level: "FAIL", fix: "systemctl --user restart dori-supervisor.service" });
  expect(find(await runDoctor(fixture({ gateway: "nocontent" }).deps), "gateway").level).toBe("WARN");
});

test("tools and disk: missing gh auth, jq or bun are FAIL; free space under the guard is WARN", async () => {
  const f = fixture({ run: { "gh auth status": no("", 1), "jq --version": { code: 127, out: "", err: "" }, "bun --version": { code: 127, out: "", err: "" } } });
  const checks = await runDoctor(f.deps);
  expect(find(checks, "gh")).toMatchObject({ level: "FAIL", fix: "gh auth login" });
  expect(find(checks, "jq").level).toBe("FAIL");
  expect(find(checks, "bun").level).toBe("FAIL");
  const low = fixture({ free: 5 });
  const d = find(await runDoctor(low.deps), "disk");
  expect(d.level).toBe("WARN");
  expect(d.detail).toContain("diskFreeMinGb is 50");
});

test("an unreachable Discord API is a bounded FAIL, not a crash", async () => {
  const f = fixture();
  const deps: DoctorDeps = { ...f.deps, http: async () => { throw new Error("offline"); } };
  expect(find(await runDoctor(deps), "discord token")).toMatchObject({ level: "FAIL", detail: "Discord API unreachable" });
});

test("tokenFrom reads the env file forms and gatewayView ages with the injected clock", () => {
  expect(tokenFrom("A=1\nDORI_DISCORD_TOKEN=abc\n")).toBe("abc");
  expect(tokenFrom('export DORI_DISCORD_TOKEN="q q"')).toBe("q q");
  expect(tokenFrom("DORI_DISCORD_TOKEN=")).toBeUndefined();
  expect(tokenFrom(undefined)).toBeUndefined();
  const s = { pid: 1, at: 1000, connected: true, messageContent: true };
  expect(gatewayView(s, 1000 + 59_000).state).toBe("live");
  expect(gatewayView(s, 1000 + 61_000).state).toBe("stale");
});

test("memory check: omo's repo for leadCwd, WARN over maxKb or when nothing is found", async () => {
  const f = fixture();
  const real = { ...f.deps, exists: existsSync };
  expect(find(await runDoctor(real), "memory check").level).toBe("OK");
  const discovered = { ...real, config: { ...real.config, memoryCheck: { ...real.config.memoryCheck, repo: "" } } };
  const missing = find(await runDoctor(discovered), "memory check");
  expect(missing.level).toBe("WARN");
  expect(missing.fix).toContain("leadCwd");
  const agent = join(f.deps.home, ".omo", "memory", "agents", `lead-${createHash("sha256").update(f.deps.config.leadCwd).digest("hex").slice(0, 8)}`, "repo", "system");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "human.md"), "x".repeat(16 * 1024));
  const over = find(await runDoctor(discovered), "memory check");
  expect(over.level).toBe("WARN");
  expect(over.detail).toContain(agent);
  expect(over.detail).toContain("over memoryCheck.maxKb 15");
});

test("item 6: doctor fails on lanes whose recovery is exhausted and warns on lanes still pending recovery", async () => {
  const f = fixture();
  const registry = new Registry(f.deps.config.stateDir);
  const base = { title: "t", thread: "none", brief: "/b", done: "d", openedAt: new Date(NOW).toISOString() };
  await registry.write({ ...base, key: "dead-lane", recoveryPending: true, recoveryAttempts: 3, recoveryExhausted: true } as Parameters<Registry["write"]>[0]);
  await registry.write({ ...base, key: "held-lane", recoveryPending: true } as Parameters<Registry["write"]>[0]);
  await registry.write({ ...base, key: "fine-lane" });
  const checks = (await runDoctor(f.deps)).filter((c) => c.id === "lane recovery");
  expect(checks.map((c) => [c.level, c.detail])).toEqual([
    ["FAIL", "exhausted, not relaunched or nudged: dead-lane (3 attempts)"],
    ["WARN", "pending, not nudged: held-lane"],
  ]);
  expect(doctorExit(await runDoctor(f.deps))).toBe(1);
});


test("doctor names each config value's source: file, default, env or derived, and warns on keys it does not read", async () => {
  const f = fixture();
  const path = join(f.deps.home, "config.json");
  writeFileSync(path, JSON.stringify({ defaultModel: "p/m", discordChannels: ["500"], laneThinking: "high" }));
  const config = await loadConfig(path, f.deps.home);
  const checks = configSources({ ...f.deps, config, configPath: path, env: { DORI_STATE_DIR: config.stateDir } });
  expect(find(checks, "config.defaultModel").detail).toStartWith("file: ");
  expect(find(checks, "config.worktreeRoot").detail).toBe('default: ""');
  expect(find(checks, "config.stateDir").detail).toStartWith("env DORI_STATE_DIR: ");
  expect(find(checks, "config.alertsChannel").detail).toBe('derived from discordChannels[0]: "500"');
  expect(find(checks, "config.decisionsChannel")).toMatchObject({ level: "WARN", detail: "decisionsChannel: unset (decisions go to the requesting channel)" });
  expect(find(checks, "config.store").detail).toStartWith("derived from ");
  expect(find(checks, "config.leadThinking").detail).toBe("unset: (none)");
  expect(find(checks, "config ignored keys")).toMatchObject({ level: "WARN", detail: expect.stringContaining("laneThinking") });
});
