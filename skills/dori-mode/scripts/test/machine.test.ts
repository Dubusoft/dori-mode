import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";

import { deadPaneTick, newDeadPaneState, UNRECOGNISED_ALERT_AFTER } from "../src/dead-panes.ts";
import { claimDone, closeLane, closedWorktreeSweep, objectDone, unpushedWork, watchTick } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { githubTargets } from "../src/github-events.ts";
import { type LaneOps, LaneOpsError, machineRunner, runnerOf } from "../src/lane-ops.ts";
import { adoptLane, footer, launchLane, paneShell } from "../src/launch.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import type { Runner } from "../src/run.ts";
import { resolveSession } from "../src/session-id.ts";
import { syncRegistry } from "../src/sync.ts";
import { depsFor, fakeClock, newWorld, type OpsEntry, sent, withState, type World, withSqliteStore } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MACHINE = "build host";
let state: ReturnType<typeof withState>;
let world: World;
/** The runner label of every facade call, in order: the lane's runner for lane calls, the machine's for pane and host reads. */
let routed: string[];
beforeEach(() => { state = withState(); withSqliteStore(state.dir); world = newWorld(); routed = []; });
afterEach(() => state.done());

const lane = (patch: Partial<Lane> = {}): Lane => ({
  key: "remote-lane", title: "remote", thread: "none", pane: "w:p3", machine: MACHINE,
  brief: join(state.dir, "brief.md"), cwd: "/remote-only/repo", done: "closed acme/app#3",
  openedAt: new Date(T0).toISOString(), ...patch,
});

const labelOf = (op: string, first: unknown): string => {
  if (op === "start" || op === "adopt") return machineRunner((first as { machine?: string }).machine);
  if (first && typeof first === "object" && "key" in first) return runnerOf(first as Pick<Lane, "runner" | "machine">);
  if (first && typeof first === "object") return machineRunner((first as { machine?: string }).machine);
  return machineRunner(first as string | undefined);
};

/** Records the runner label of every call; `connected` is a probe, not a call. */
const routing = (ops: LaneOps): LaneOps => Object.fromEntries(Object.entries(ops).map(([name, fn]) => [name, (...args: unknown[]) => {
  if (name !== "connected") routed.push(labelOf(name, args[0]));
  return (fn as (...a: unknown[]) => unknown)(...args);
}])) as LaneOps;

/**
 * Deps over the World whose facade lists the World's panes on the machine only (`remote`), or on this host only, the way
 * two hosts with the same pane ids look; `patch` replaces facade methods.
 */
const deps = (remote = true, patch: Partial<LaneOps> = {}) => {
  const base = depsFor(world, fakeClock(T0), state.dir);
  const panes: LaneOps["panes"] = async (machine) => {
    const all = await base.ops.panes(machine);
    return (machine === MACHINE) === remote ? all : [];
  };
  world.panes = [{ pane_id: "w:p3", workspace_id: "w", agent: "pi", agent_status: "idle" }];
  return { ...base, ops: routing({ ...base.ops, panes, ...patch }) };
};

/** An idle shell pane: launch may start a lane in it. */
const shellPane = (cwd?: string) => {
  world.panes = [{ pane_id: "w:p3", workspace_id: "w", ...(cwd ? { cwd } : {}) }];
  world.inspection = { process: { shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [] } as never };
  world.startResult = { pane: "w:p3", tab: "w:t3", startup: { verdict: "ok", detail: "" } };
};

const opsOf = (op: OpsEntry["op"]) => world.ops.filter((e) => e.op === op);
const startInput = () => opsOf("start")[0]?.args as Record<string, unknown> | undefined;
const expectRemote = () => {
  expect(routed.length).toBeGreaterThan(0);
  for (const label of routed) expect(label).toBe(MACHINE);
};

test("remote --pane launch checks the pane and starts the lane through the machine's runner and persists machine", async () => {
  const d = deps();
  shellPane();
  const input = lane();
  await Bun.write(input.brief, "execute the requested work\n");
  // An identical local pane ID must not make the remote pane owned.
  await d.registry.write(lane({ key: "local-owner", machine: undefined }));
  const result = await launchLane(d, { ...input, pane: "w:p3" });
  expectRemote();
  expect(result.startup).toStartWith("STARTUP_OK remote-lane w:p3");
  expect(await d.registry.read(input.key)).toMatchObject({ machine: MACHINE, runner: MACHINE, pane: "w:p3", tab: "w:t3", remoteCwd: "/remote-only/repo" });
  expect(startInput()).toMatchObject({ machine: MACHINE, cwd: "/remote-only/repo", target: { pane: "w:p3" } });
  // Heavy slots are the lead host's; a remote lane's runner keeps its own.
  expect(startInput()).not.toHaveProperty("heavySlots");
  expect(opsOf("processInfo").map((e) => e.args)).toEqual([{ machine: MACHINE, pane: "w:p3" }]);
  // A remote directory is never checked as a local checkout.
  expect(opsOf("inspect")).toEqual([]);
  expect(world.calls).toEqual([]);
});

test("remote --workspace launch resolves the shell pane from that machine's inventory", async () => {
  const d = deps();
  shellPane();
  const input = lane({ pane: undefined });
  await Bun.write(input.brief, "work\n");
  const result = await launchLane(d, { ...input, workspace: "w" });
  expect(result.lane.pane).toBe("w:p3");
  expectRemote();
  expect(opsOf("panes").map((e) => e.args)).toContainEqual({ machine: MACHINE });
  expect(startInput()).toMatchObject({ target: { pane: "w:p3" } });
});

test("plain remote launch needs a directory on the machine and never sends the lead's workspace or defaultCwd", async () => {
  const d = deps();
  const config = { ...d.config, laneWorkspace: "local-only-workspace" };
  await Bun.write(lane().brief, "work\n");
  // The lead's defaultCwd means nothing on the machine.
  await expect(launchLane({ ...d, config }, lane({ pane: undefined, cwd: undefined }))).rejects.toThrow(`a lane on machine ${MACHINE} needs --cwd`);
  expect(opsOf("start")).toEqual([]);
  expect(await d.registry.read("remote-lane")).toBeNull();
  world.startResult = { pane: "w:p8", tab: "w:t8", startup: { verdict: "ok", detail: "" } };
  expect((await launchLane({ ...d, config }, lane({ pane: undefined }))).lane.tab).toBe("w:t8");
  expectRemote();
  expect(startInput()).toMatchObject({ machine: MACHINE, cwd: "/remote-only/repo" });
  expect(startInput()).not.toHaveProperty("target");
  expect(JSON.stringify(startInput())).not.toContain("local-only-workspace");
  expect(await d.registry.read("remote-lane")).toMatchObject({ remoteCwd: "/remote-only/repo" });
  expect((await d.registry.read("remote-lane"))?.cwd).toBeUndefined();
});

test("a remote launch hands the complete brief text to the machine's runner, never a lead-local path", async () => {
  const d = deps();
  shellPane();
  const input = lane({ key: `remote-posix-${process.pid}`, brief: join(state.dir, "quoted ' brief.md") });
  await Bun.write(input.brief, "literal ' quote and $(printf INJECTED) and `printf INJECTED`\n");
  await launchLane(d, input);
  const shipped = await Bun.file(input.brief).text();
  const start = startInput();
  expect(start?.briefText).toBe(shipped);
  expect(String(start?.briefText)).toContain(`~/.dori/runner/bin/dori report ${input.key} done`);
  expect(JSON.stringify(start)).not.toContain(state.dir);
});

test("a cmd.exe pane is refused before anything runs or registers", async () => {
  const d = deps();
  world.panes = [{ pane_id: "w:p3", workspace_id: "w", cwd: "D:\\dev\\worktrees\\app" }];
  world.inspection = { process: { shell_pid: 4100, foreground_processes: [{ pid: 4100, name: "cmd.exe", argv: ["C:\\Windows\\System32\\cmd.exe"] }] } as never };
  const input = lane();
  await Bun.write(input.brief, "work\n");
  await expect(launchLane(d, { ...input, pane: "w:p3" })).rejects.toThrow("runs cmd.exe");
  expect(opsOf("start")).toEqual([]);
  expect(await d.registry.read(input.key)).toBeNull();
});

test("pane shell detection reads the shell process, then a Windows drive cwd", () => {
  const info = (name: string) => ({ shell_pid: 1, foreground_processes: [{ pid: 1, name }] });
  expect(paneShell(info("powershell.exe"))).toBe("powershell");
  expect(paneShell(info("pwsh"))).toBe("pwsh");
  expect(paneShell(info("CMD.EXE"))).toBe("cmd");
  expect(paneShell(info("-zsh"))).toBe("posix");
  expect(paneShell(undefined, "D:\\dev")).toBe("powershell");
  expect(paneShell(undefined, "/home/u")).toBe("posix");
});

test("remote footer reports through the runner's lane CLI; local footer through dori report; neither types into a pane", () => {
  const remote = footer(lane());
  expect(remote).toContain('~/.dori/runner/bin/dori report remote-lane done --text "<one line>"');
  expect(remote).not.toContain("dori claim-done remote-lane");
  expect(remote).not.toContain("[REPORT]");
  expect(remote).not.toContain("lead:p1");
  const local = footer(lane({ machine: undefined }));
  expect(local).toContain('When done: dori report remote-lane done --text "<one line>" --evidence "<merge SHA, closed issue, version>"');
  expect(local).not.toContain("~/.dori/runner/bin/dori");
  expect(local).not.toContain("[REPORT]");
});

test("close runs a remote lane's command signals in the local defaultCwd, also for entries that stored the remote path", async () => {
  for (const entry of [lane({ cwd: undefined, remoteCwd: "D:\\dev\\app" }), lane({ cwd: "D:\\dev\\app" })]) {
    world.ops = [];
    const d = deps();
    await d.registry.write(entry);
    const result = await closeLane(d, { ...entry, done: 'command ["gh","pr","list"] stdout~"MERGED"' }, "verified");
    expect(result.closed).toBe(true);
    const asked = opsOf("inspect").map((e) => (e.args as { want: Record<string, unknown> }).want).filter((want) => want.done !== undefined);
    expect(asked).toEqual([{ done: 'command ["gh","pr","list"] stdout~"MERGED"', doneCwd: d.config.defaultCwd }]);
  }
});

test("adopt --machine keeps the given directory as the remote path, never as a local cwd", async () => {
  const d = deps();
  const adopted = await adoptLane(d, { ...lane({ cwd: "D:\\dev\\app" }), pane: "w:p3" });
  expect(adopted).toMatchObject({ remoteCwd: "D:\\dev\\app", runner: MACHINE });
  expect(adopted.cwd).toBeUndefined();
  expect(opsOf("adopt")[0]?.args).toMatchObject({ key: "remote-lane", machine: MACHINE, pane: "w:p3", cwd: "D:\\dev\\app" });
  expect((await adoptLane(d, { ...lane({ key: "local-adopted", machine: undefined, cwd: "/repo/x" }), pane: "w:p4" })).cwd).toBe("/repo/x");
});

test("adopt without --machine refuses a pane id the local runner does not list; with --machine the same id is adopted", async () => {
  let d = deps();
  const adopt = d.ops.adopt;
  d = deps(true, {
    adopt: async (input) => {
      if (!input.machine) throw new LaneOpsError("LANE_OP_FAILED", "local", "RUNNER_LANE_PANE_MISSING pane w:p3 not found");
      return adopt(input);
    },
  });
  await expect(adoptLane(d, { ...lane({ machine: undefined }), pane: "w:p3" })).rejects.toThrow("needs --machine");
  expect(await d.registry.read("remote-lane")).toBeNull();
  expect((await adoptLane(d, { ...lane(), pane: "w:p3" })).machine).toBe(MACHINE);
});

test("launch --pane without --machine refuses a pane id only the machine lists; nothing starts or registers", async () => {
  const d = deps();
  shellPane();
  const input = lane({ machine: undefined, cwd: undefined });
  await Bun.write(input.brief, "work\n");
  await expect(launchLane(d, { ...input, pane: "w:p3" })).rejects.toThrow("pane w:p3 does not exist on this host; a pane on another machine needs --machine LABEL");
  expect(opsOf("start")).toEqual([]);
  expect(await d.registry.read(input.key)).toBeNull();
});

test("a remote start the runner refuses is not registered as a launched lane", async () => {
  const d = deps(true, { start: async () => { throw new LaneOpsError("LANE_OP_FAILED", MACHINE, "RUNNER_LANE_START_FAILED machine disconnected"); } });
  const input = lane({ pane: undefined });
  await Bun.write(input.brief, "work\n");
  await expect(launchLane(d, input)).rejects.toThrow("machine disconnected");
  expect(await d.registry.read(input.key)).toBeNull();
});

test("a remote startup failure the runner reports becomes the STARTUP_ERROR line", async () => {
  const d = deps();
  world.startResult = { pane: "w:p3", tab: "w:t3", startup: { verdict: "error", detail: "Error: No API key" } };
  const input = lane({ pane: undefined });
  await Bun.write(input.brief, "work\n");
  expect((await launchLane(d, input)).startup).toBe("STARTUP_ERROR remote-lane w:p3: Error: No API key");
  expectRemote();
});

test("adopt records machine and sync reads its inventory and session through the machine's runner", async () => {
  const d = deps();
  await adoptLane(d, { ...lane(), pane: "w:p3" });
  expect((await d.registry.read("remote-lane"))?.machine).toBe(MACHINE);
  world.inspection = { session: { id: "remote-session", via: "argv" } };
  const result = await syncRegistry(d, true);
  expect(result.drift).toEqual([]);
  expect(result.rows[0]?.session).toBe("remote-session (argv)");
  expect((await d.registry.read("remote-lane"))?.session).toBe("remote-session");
  expect(opsOf("panes").map((e) => e.args)).toContainEqual({ machine: MACHINE });
  const asked = opsOf("inspect").at(-1)?.args as { lane: Lane; want: Record<string, unknown> };
  expect(asked.lane).toMatchObject({ key: "remote-lane", machine: MACHINE, pane: "w:p3" });
  expect(asked.want).toMatchObject({ session: true });
});

test("local entries stay local without machine: every call goes to the local runner", async () => {
  const d = deps(false);
  const input = lane({ machine: undefined });
  await adoptLane(d, { ...input, pane: "w:p3" });
  await syncRegistry(d, false);
  expect((await d.registry.read(input.key))?.machine).toBeUndefined();
  expect(routed.length).toBeGreaterThan(0);
  // sync lists every machine a lane is on; with no remote lane that is only this host.
  expect(routed.every((label) => label === "local")).toBe(true);
});

test("byPane distinguishes a local pane from the same ID on a saved machine", async () => {
  const d = deps();
  await d.registry.write(lane());
  await d.registry.write(lane({ key: "local-lane", machine: undefined }));
  expect((await d.registry.byPane("w:p3"))?.key).toBe("local-lane");
  expect((await d.registry.byPane("w:p3", MACHINE))?.key).toBe("remote-lane");
});

test("remote pause pauses the goal and interrupts only the remote turn, through the machine's runner", async () => {
  const d = deps();
  const input = lane();
  for (const pane of world.panes) pane.agent_status = "working";
  world.onEscapeStatus = "idle";
  const result = await pauseLane(d, input, "wait");
  expect(result.code).toBe(0);
  expect(result.lane.status).toBe("paused");
  expectRemote();
  expect(opsOf("pause").map((e) => (e.args as { step?: string }).step)).toEqual(["goal", "stop"]);
});

test("remote resume reads back the remote goal before restoring lane state", async () => {
  const d = deps();
  const result = await resumeLane(d, lane({ status: "paused" }), "go");
  expect(result.code).toBe(0);
  expect(result.lane.status).toBe("working");
  expect(opsOf("resume")).toHaveLength(1);
  expectRemote();
});

test("claim and objection messages route to the remote lane's runner", async () => {
  const d = deps();
  await claimDone(d, lane(), "verified");
  await objectDone(d, lane(), ["not yet"]);
  expectRemote();
  expect(opsOf("send")).toHaveLength(2);
});

test("an objection tells a remote lane to read the reasons with its runner's dori, and never types them", async () => {
  const d = deps();
  await d.registry.write(lane());
  await claimDone(d, lane(), "closed acme/app#3");
  await objectDone(d, (await d.registry.read("remote-lane")) ?? lane(), ["changelog missing"]);
  const objection = sent(world).at(-1) ?? "";
  expect(objection).toBe("[LEAD] not done: the Done check of remote-lane did not pass; the lead has the reasons. Read them with ~/.dori/runner/bin/dori lane status remote-lane, keep working, and claim again when fixed");
  expectRemote();
});

test("freshness nudges a quiet remote lane through its runner without touching the local namesake", async () => {
  const d = deps();
  await d.registry.write(lane({ openedAt: new Date(T0 - 16 * 60_000).toISOString() }));
  expect((await freshnessTick(d)).map((act) => act.kind)).toEqual(["nudged"]);
  expectRemote();
  expect(opsOf("send")[0]?.args).toMatchObject({ text: expect.stringContaining("~/.dori/runner/bin/dori report remote-lane"), opts: { refuseWhileAsking: true } });
});

test("dead-panes scopes remote reads and state independently from local IDs", async () => {
  const d = deps();
  world.panes = [{ pane_id: "w:p3", workspace_id: "w" }, { pane_id: "w:p9", workspace_id: "w" }];
  world.screen = "agent has stopped";
  const seen = new Set<string>();
  const memory = newDeadPaneState();
  expect(await deadPaneTick(d.ops, d.config, seen, "hour", memory, [lane()])).toEqual([]);
  const result = await deadPaneTick(d.ops, d.config, seen, "hour", memory, [lane()]);
  expect(result).toEqual([`DEAD_PANE w:p3 machine=${MACHINE}`]);
  const reads = opsOf("screen").map((e) => e.args as { machine?: string; pane?: string; lines?: number });
  expect(reads).toContainEqual({ machine: MACHINE, pane: "w:p3", lines: 6 });
  expect(reads.some((r) => r.pane === "w:p9")).toBe(false);
});

test("dead-panes never alerts on a remote host's own panes over several sweeps", async () => {
  const d = deps();
  // The machine's herdr lists the lane's working pane plus panes no lane owns: a plain shell and another workspace's pane.
  world.panes = [
    { pane_id: "w:p3", workspace_id: "w", agent: "pi", agent_status: "working" },
    { pane_id: "w:p9", workspace_id: "w" },
    { pane_id: "x:p1", workspace_id: "x" },
  ];
  world.screen = "user@build:~$ ";
  const seen = new Set<string>();
  const memory = newDeadPaneState();
  for (let tick = 0; tick <= UNRECOGNISED_ALERT_AFTER; tick++) expect(await deadPaneTick(d.ops, d.config, seen, "hour", memory, [lane()])).toEqual([]);
  expect(opsOf("screen")).toEqual([]);
  // With no lane registered on the machine, the sweep does not ask its runner at all.
  routed = [];
  for (let tick = 0; tick <= UNRECOGNISED_ALERT_AFTER; tick++) expect(await deadPaneTick(d.ops, d.config, seen, "hour", memory, [])).toEqual([]);
  expect(routed).not.toContain(MACHINE);
});

test("remote worktree checks and cleanup skip explicitly and never ask for git", async () => {
  const d = deps();
  const input = lane({ worktrees: ["/remote-only/repo"] });
  expect(await unpushedWork(d, input)).toEqual([]);
  expect(await closedWorktreeSweep(d, { ...input, closedAt: new Date(T0).toISOString(), receipt: { cleanup: ["worktree /data/repos/worktrees/x kept: dirty"] } })).toEqual([]);
  const result = await closeLane(d, input, "verified");
  expect(result.closed).toBe(true);
  expect(result.lines.some((line) => line.startsWith("WORKTREE_CHECK SKIPPED"))).toBe(true);
  expect((await d.registry.read(input.key))?.receipt).toMatchObject({ worktreeCheck: { status: "skipped" } });
  expect(opsOf("git")).toEqual([]);
  expect(opsOf("inspect").some((e) => (e.args as { want: { git?: boolean } }).want.git)).toBe(false);
  expect(world.calls.some((argv) => argv[0] === "git")).toBe(false);
  expectRemote();
});

test("watch settles a remote claim using remote close and records skipped worktree detail", async () => {
  const d = deps();
  await d.registry.write(lane({ status: "done-claimed", claim: { at: new Date(T0 - 6 * 60_000).toISOString(), evidence: "verified", emitted: true } }));
  expect((await watchTick(d))[0]).toStartWith("LANE_CLOSED");
  expect((await d.registry.read("remote-lane"))?.receipt).toMatchObject({ worktreeCheck: { status: "skipped" } });
  expect(opsOf("close")).toHaveLength(1);
  expectRemote();
});

test("no remote lane is read from its screen for a report, whatever footer it was launched with", async () => {
  for (const registered of [lane({ reportVia: "cli", runner: MACHINE }), lane()]) {
    const d = deps();
    await d.registry.write(registered);
    world.screen = "[REPORT] remote-lane | question | which base branch?\n[REPORT] remote-lane | done | closed acme/app#3\n❯ ";
    expect(await watchTick(d)).toEqual([]);
    expect(opsOf("screen")).toEqual([]);
    const after = await d.registry.read("remote-lane");
    expect(after && statusOf(after)).toBe("working");
    expect(after?.remoteReportsSeen).toBeUndefined();
  }
});

test("remote session lookup cannot mistake a local matching PID for its session", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, err: "", out: JSON.stringify({ result: { process_info: { shell_pid: 100 } } }) };
  };
  const result = await resolveSession("w:p3", "/repo", [{ pid: 200, ppid: 100, cmd: "omo --session-id wrong-local" }], {
    run, sessionsDir: "/local/sessions", listDir: () => { throw new Error("must not read local sessions"); },
  }, { machine: MACHINE });
  expect(result).toEqual({ id: "", via: "none" });
  expect(calls).toEqual([["herdr", "pane", "process-info", "--pane", "w:p3"]]);
});

test("GitHub supervision keeps remote signal targets without asking any runner for remote paths", async () => {
  const d = deps();
  const targets = await githubTargets([lane({ done: 'merged acme/app#7; command ["gh","pr","list","-R","other/repo","--head","remote-branch"]' })], d.ops);
  expect([...targets.get("acme/app")?.numbers ?? []]).toEqual([7]);
  expect([...targets.get("other/repo")?.branches ?? []]).toEqual(["remote-branch"]);
  expect(world.ops).toEqual([]);
  expect(world.calls).toEqual([]);
});

test("sync's session update re-reads the lane, so an objection written while sync ran survives", async () => {
  const objection = { at: new Date(T0).toISOString(), reasons: ["unpushed work"] };
  let d = deps();
  const inspect = d.ops.inspect;
  const registry = d.registry;
  d = deps(true, {
    inspect: async (l, want) => {
      const current = await registry.read("remote-lane");
      if (want.session && current && !current.objection) await registry.write({ ...current, status: "not-done", objection });
      return inspect(l, want);
    },
  });
  await adoptLane(d, { ...lane(), pane: "w:p3" });
  world.inspection = { session: { id: "remote-session", via: "argv" } };
  await syncRegistry(d, true);
  const after = await d.registry.read("remote-lane");
  expect(after?.session).toBe("remote-session");
  expect(after?.objection).toEqual(objection);
  expect(after?.status).toBe("not-done");
});
