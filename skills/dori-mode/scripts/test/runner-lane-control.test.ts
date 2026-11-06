import { expect, test } from "bun:test";

import type { Ran, Runner } from "../src/run.ts";
import {
  goalCommand, lastLines, PAUSED_SHOWN, pause, paneShell, resolveTargetPane, resume, resumeArgv, startupFailure, startupPoll, stopTurn,
  STARTUP_POLLS, TargetError,
} from "../src/runner/lane-control.ts";
import { fakeClock, fakeRunner, newWorld, type World } from "./fakes.ts";

const T0 = 1_800_000_000_000;

const world = (status = "working"): World => {
  const w = newWorld();
  w.panes = [{ pane_id: "p1", workspace_id: "w1", tab_id: "t1", agent: "omo", agent_status: status }];
  return w;
};

const deps = (w: World) => ({ run: fakeRunner(w), clock: fakeClock(T0) });
const sentText = (w: World): string[] => w.calls.filter((c) => c[2] === "send-text").map((c) => c[4] ?? "");
const escapes = (w: World): number => w.calls.filter((c) => c[2] === "send-keys" && c[4] === "escape").length;

test("pause both: goal confirmed from the screen, the running turn stopped by Escape", async () => {
  const w = world("working");
  w.onEscapeStatus = "idle";
  // before the send, the guard's input-box read, then the read-back showing the goal paused
  w.screens = ["❯ ", "❯ ", "Goal paused\n❯ "];
  expect(await pause(deps(w), "p1", "both")).toEqual({ goal: "confirmed", working: true, stopped: true });
  expect(sentText(w)).toEqual(["/goal pause"]);
  expect(escapes(w)).toBe(1);
});

test("pause defaults to both", async () => {
  const w = world("working");
  w.onEscapeStatus = "idle";
  w.screens = ["❯ ", "❯ ", "Goal paused\n❯ "];
  expect(await pause(deps(w), "p1")).toEqual({ goal: "confirmed", working: true, stopped: true });
});

test("pause both stops before Escape when the goal is not confirmed", async () => {
  const w = world("working");
  w.onEscapeStatus = "idle";
  expect(await pause(deps(w), "p1", "both")).toEqual({ goal: "unconfirmed" });
  expect(escapes(w)).toBe(0);
});

test("pause goal only never presses Escape", async () => {
  const w = world("working");
  w.screens = ["❯ ", "❯ ", "Goal paused\n❯ "];
  expect(await pause(deps(w), "p1", "goal")).toEqual({ goal: "confirmed" });
  expect(escapes(w)).toBe(0);
});

test("pause stop on an idle pane sends nothing and counts as stopped", async () => {
  const w = world("idle");
  expect(await pause(deps(w), "p1", "stop")).toEqual({ working: false, stopped: true });
  expect(escapes(w)).toBe(0);
  expect(sentText(w)).toEqual([]);
});

test("stopTurn reports false when the turn keeps running after Escape", async () => {
  const w = world("working");
  expect(await stopTurn(deps(w), "p1")).toBe(false);
});

test("goalCommand: a pane without a live agent is failed, nothing typed", async () => {
  const w = world("working");
  w.panes = [{ pane_id: "p1", workspace_id: "w1" }];
  expect(await goalCommand(deps(w), "p1", "/goal pause", PAUSED_SHOWN)).toBe("failed");
  expect(sentText(w)).toEqual([]);
});

test("goalCommand counts only new whole lines: an old 'Goal paused' line does not confirm", async () => {
  const w = world("idle");
  w.screen = "Goal paused\n❯ ";
  expect(await goalCommand(deps(w), "p1", "/goal pause", PAUSED_SHOWN)).toBe("unconfirmed");
});

test("resume confirms 'Goal active'", async () => {
  const w = world("idle");
  w.screens = ["❯ ", "❯ ", "Goal active\n❯ "];
  expect(await resume(deps(w), "p1")).toEqual({ goal: "confirmed" });
  expect(sentText(w)).toEqual(["/goal resume"]);
});

// ---------------------------------------------------------------------------------------------------------------

const scripted = (answers: Record<string, unknown>): Runner => async (argv): Promise<Ran> => {
  const key = argv.slice(0, 4).join(" ");
  const hit = Object.entries(answers).find(([k]) => key.startsWith(k));
  if (!hit) return { code: 1, out: "", err: `unexpected ${argv.join(" ")}` };
  const v = hit[1];
  return typeof v === "object" && v !== null && "code" in v ? (v as Ran) : { code: 0, out: JSON.stringify(v), err: "" };
};

const idleShell = {
  "herdr pane get p9": { result: { pane: { pane_id: "p9", workspace_id: "w1", tab_id: "t9", cwd: "/repo" } } },
  "herdr pane process-info --pane": { result: { process_info: { shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "bash" }] } } },
};

test("resolveTargetPane accepts an idle shell pane no lane owns", async () => {
  const got = await resolveTargetPane(scripted(idleShell), { pane: "p9" }, { ownerOf: () => undefined, refuseCmd: true });
  expect(got).toEqual({ pane: "p9", tab: "t9", cwd: "/repo", shell: "posix" });
});

test("resolveTargetPane picks the one shell pane of a workspace", async () => {
  const run = scripted({ ...idleShell, "herdr pane list": { result: { panes: [{ pane_id: "p8", workspace_id: "w1", agent: "omo" }, { pane_id: "p9", workspace_id: "w1" }, { pane_id: "p7", workspace_id: "w2" }] } } });
  expect((await resolveTargetPane(run, { workspace: "w1" }, { ownerOf: () => undefined, refuseCmd: true })).pane).toBe("p9");
});

test("resolveTargetPane refuses busy panes with RUNNER_LANE_TARGET_BUSY", async () => {
  const owned = resolveTargetPane(scripted(idleShell), { pane: "p9" }, { ownerOf: () => "other-lane", refuseCmd: true });
  await expect(owned).rejects.toThrow("RUNNER_LANE_TARGET_BUSY pane p9 is already registered to lane other-lane");
  const foreground = scripted({ ...idleShell, "herdr pane process-info --pane": { result: { process_info: { shell_pid: 10, foreground_process_group_id: 11 } } } });
  const err = await resolveTargetPane(foreground, { pane: "p9" }, { ownerOf: () => undefined, refuseCmd: true }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TargetError);
  expect((err as TargetError).code).toBe("RUNNER_LANE_TARGET_BUSY");
});

test("resolveTargetPane refuses a missing pane and a cmd.exe pane when asked", async () => {
  await expect(resolveTargetPane(scripted({}), { pane: "p9" }, { ownerOf: () => undefined, refuseCmd: true })).rejects.toThrow("RUNNER_LANE_TARGET_INVALID pane p9 does not exist");
  const cmd = scripted({ ...idleShell, "herdr pane process-info --pane": { result: { process_info: { shell_pid: 10, foreground_processes: [{ pid: 10, name: "cmd.exe" }] } } } });
  await expect(resolveTargetPane(cmd, { pane: "p9" }, { ownerOf: () => undefined, refuseCmd: true })).rejects.toThrow("runs cmd.exe");
  expect((await resolveTargetPane(cmd, { pane: "p9" }, { ownerOf: () => undefined, refuseCmd: false })).shell).toBe("cmd");
});

test("paneShell reads pwsh and a drive-letter cwd as PowerShell", () => {
  expect(paneShell({ shell_pid: 1, foreground_processes: [{ pid: 1, name: "pwsh.exe" }] })).toBe("powershell");
  expect(paneShell(undefined, "D:\\work")).toBe("powershell");
  expect(paneShell(undefined, "/home/x")).toBe("posix");
});

// ---------------------------------------------------------------------------------------------------------------

test("startupPoll: two ready reads in a row are ok", async () => {
  const w = world("working");
  expect(await startupPoll(deps(w), "p1")).toEqual({ verdict: "ok", detail: "ready" });
});

test("startupPoll: a failure word on an idle screen is an error at once", async () => {
  const w = world("idle");
  w.screen = "Error: No API key found for provider\n❯ ";
  expect(await startupPoll(deps(w), "p1")).toEqual({ verdict: "error", detail: "No API key" });
});

test("startupPoll: never ready is unconfirmed with why and the last lines", async () => {
  const w = world("blocked");
  w.screen = "loading\nstill loading\n❯ ";
  const clock = fakeClock(T0);
  const slept: number[] = [];
  const v = await startupPoll({ run: fakeRunner(w), clock: { ...clock, sleep: async (ms: number) => { slept.push(ms); } } }, "p1");
  expect(v).toEqual({ verdict: "unconfirmed", detail: "no ready agent status (blocked); last lines: loading / still loading / ❯" });
  expect(slept.length).toBe(STARTUP_POLLS);
});

test("startupFailure skips tips and brief echoes; lastLines masks home paths", () => {
  expect(startupFailure("Tip: usage limit reached tips\n\nRead the lane brief at /x: quota exceeded")).toBeUndefined();
  expect(startupFailure("usage limit reached")).toBe("usage limit reached");
  expect(lastLines("a\n/home/u/secret here\n")).toBe("a / (local path) here");
});

test("resumeArgv inserts --session before the prompt, and refuses what it cannot resume", () => {
  expect(resumeArgv(["omo", "--model", "{model}", "{prompt}"], "abc-1")).toEqual(["omo", "--model", "{model}", "--session", "abc-1", "{prompt}"]);
  expect(resumeArgv(["omo", "{prompt}"], undefined)).toBeUndefined();
  expect(resumeArgv(["omo", "{prompt}"], "-x")).toBeUndefined();
  expect(resumeArgv(["omo", "--continue", "{prompt}"], "abc")).toBeUndefined();
  expect(resumeArgv(["{prompt}"], "abc")).toBeUndefined();
});
