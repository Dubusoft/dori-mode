import { expect, test } from "bun:test";

import type { Runner } from "../src/run.ts";
import {
  goalCommand, lastLines, PAUSED_SHOWN, pause, resume, RESUME_TEXT, resumeArgv, startupFailure, startupPoll, stopTurn,
} from "../src/runner/lane-control.ts";
import { fakeClock, fakeRunner, newWorld, type World } from "./fakes.ts";

const T0 = 1_800_000_000_000;

const world = (status = "working"): World => {
  const w = newWorld();
  w.panes = [{ pane_id: "hc:t1", workspace_id: "w1", tab_id: "t1", agent: "omo", agent_status: status }];
  return w;
};

const deps = (w: World) => ({ run: fakeRunner(w), clock: fakeClock(T0) });
const sentText = (w: World): string[] => w.calls.filter((c) => c[0] === "hc" && c[2] === "send").map((c) => c[5] ?? "");
const escapes = (w: World): number => w.calls.filter((c) => c[0] === "hc" && c[2] === "keys" && c[4] === "esc").length;
/** An Enter reached the pane: typed text (hc pastes it and presses Enter in one `send`) or `hc keys <addr> enter`. */
const isEnter = (argv: readonly string[]): boolean => argv[0] === "hc" && (argv[2] === "send" || (argv[2] === "keys" && argv[4] === "enter"));

test("pause both: goal confirmed from the screen, the running turn stopped by Escape", async () => {
  const w = world("working");
  w.onEscapeStatus = "idle";
  // before the send, the guard's input-box read, then the read-back showing the goal paused
  w.screens = ["❯ ", "❯ ", "Goal paused\n❯ "];
  expect(await pause(deps(w), "hc:t1", "both")).toEqual({ goal: "confirmed", working: true, stopped: true });
  expect(sentText(w)).toEqual(["/goal pause"]);
  expect(escapes(w)).toBe(1);
});

test("pause defaults to both", async () => {
  const w = world("working");
  w.onEscapeStatus = "idle";
  w.screens = ["❯ ", "❯ ", "Goal paused\n❯ "];
  expect(await pause(deps(w), "hc:t1")).toEqual({ goal: "confirmed", working: true, stopped: true });
});

test("pause both stops before Escape when the goal is not confirmed", async () => {
  const w = world("working");
  w.onEscapeStatus = "idle";
  expect(await pause(deps(w), "hc:t1", "both")).toEqual({ goal: "unconfirmed" });
  expect(escapes(w)).toBe(0);
});

test("pause goal only never presses Escape", async () => {
  const w = world("working");
  w.screens = ["❯ ", "❯ ", "Goal paused\n❯ "];
  expect(await pause(deps(w), "hc:t1", "goal")).toEqual({ goal: "confirmed" });
  expect(escapes(w)).toBe(0);
});

test("pause stop on an idle pane sends nothing and counts as stopped", async () => {
  const w = world("idle");
  expect(await pause(deps(w), "hc:t1", "stop")).toEqual({ working: false, stopped: true });
  expect(escapes(w)).toBe(0);
  expect(sentText(w)).toEqual([]);
});

test("stopTurn reports false when the turn keeps running after Escape", async () => {
  const w = world("working");
  expect(await stopTurn(deps(w), "hc:t1")).toBe(false);
});

test("goalCommand: a pane without a live agent is failed, nothing typed", async () => {
  const w = world("working");
  w.panes = [{ pane_id: "hc:t1", workspace_id: "w1" }];
  expect(await goalCommand(deps(w), "hc:t1", "/goal pause", PAUSED_SHOWN)).toBe("failed");
  expect(sentText(w)).toEqual([]);
});

test("goalCommand counts only new whole lines: an old 'Goal paused' line does not confirm", async () => {
  const w = world("idle");
  w.screen = "Goal paused\n❯ ";
  expect(await goalCommand(deps(w), "hc:t1", "/goal pause", PAUSED_SHOWN)).toBe("unconfirmed");
});

test("resume confirms 'Goal active' and a running turn, typing nothing more", async () => {
  const w = world("idle");
  w.screens = ["❯ ", "❯ ", "Goal active\n❯ "];
  w.onEnterStatus = "working";
  expect(await resume(deps(w), "hc:t1")).toEqual({ goal: "confirmed", execution: "running" });
  expect(sentText(w)).toEqual(["/goal resume"]);
});

test("resume: a goal active but a session left held is held, after one message to release it", async () => {
  const w = world("idle");
  w.screens = ["❯ ", "❯ ", "Goal active\n❯ "];
  expect(await resume(deps(w), "hc:t1")).toEqual({ goal: "confirmed", execution: "held" });
  expect(sentText(w)).toEqual(["/goal resume", RESUME_TEXT]);
});

test("resume: a held session the message releases is running", async () => {
  const w = world("idle");
  w.screens = ["❯ ", "❯ ", "Goal active\n❯ "];
  let enters = 0;
  const run: Runner = async (argv) => {
    // The /goal resume Enter leaves the session idle; the release message's Enter starts a turn.
    if (isEnter(argv) && ++enters === 2) w.onEnterStatus = "working";
    return fakeRunner(w)(argv);
  };
  expect(await resume({ run, clock: fakeClock(T0) }, "hc:t1")).toEqual({ goal: "confirmed", execution: "running" });
  expect(sentText(w)).toEqual(["/goal resume", RESUME_TEXT]);
});

const ESC_FOOTER = "❯ \n(😺 OmO Native by Q Kim) ◉ working (5m) Paused · 2 updates held · type to continue, /resume to resume";

test("resume: a turn the pause cut with Escape gets /resume after the goal, and runs", async () => {
  const w = world("idle");
  w.screens = ["❯ ", "❯ ", "Goal active\n❯ "];
  w.screen = ESC_FOOTER;
  let enters = 0;
  const run: Runner = async (argv) => {
    // /goal resume alone leaves the cut turn paused; the /resume Enter continues it.
    if (isEnter(argv) && ++enters === 2) w.onEnterStatus = "working";
    return fakeRunner(w)(argv);
  };
  expect(await resume({ run, clock: fakeClock(T0) }, "hc:t1")).toEqual({ goal: "confirmed", execution: "running" });
  expect(sentText(w)).toEqual(["/goal resume", "/resume"]);
});

test("resume: an Escape-paused session /resume does not start falls back to the release message", async () => {
  const w = world("idle");
  w.screens = ["❯ ", "❯ ", "Goal active\n❯ "];
  w.screen = ESC_FOOTER;
  expect(await resume(deps(w), "hc:t1")).toEqual({ goal: "confirmed", execution: "held" });
  expect(sentText(w)).toEqual(["/goal resume", "/resume", RESUME_TEXT]);
});

test("resume: a goal not confirmed types no /resume, even under the paused footer", async () => {
  const w = world("idle");
  w.screen = ESC_FOOTER;
  expect(await resume(deps(w), "hc:t1")).toEqual({ goal: "unconfirmed" });
  expect(sentText(w)).toEqual(["/goal resume"]);
});

test("resume: a session with no goal that stays held is held", async () => {
  const w = world("idle");
  w.screens = ["❯ ", "❯ ", "Error: cannot update goal: no goal exists\n❯ "];
  expect(await resume(deps(w), "hc:t1")).toEqual({ goal: "confirmed", execution: "held" });
  expect(sentText(w)).toEqual(["/goal resume", RESUME_TEXT]);
});

// ---------------------------------------------------------------------------------------------------------------


// ---------------------------------------------------------------------------------------------------------------

test("startupPoll: two ready reads in a row are ok", async () => {
  const w = world("working");
  expect(await startupPoll(deps(w), "hc:t1")).toEqual({ verdict: "ok", detail: "ready" });
});

test("startupPoll: a failure word on an idle screen is an error at once", async () => {
  const w = world("idle");
  w.screen = "Error: No API key found for provider\n❯ ";
  expect(await startupPoll(deps(w), "hc:t1")).toEqual({ verdict: "error", detail: "No API key" });
});

test.each([false, true])("startupPoll confirms readiness past the old window without resending (worked earlier=%s)", async (workedEarlier) => {
  const w = world("unknown");
  const clock = fakeClock(T0);
  const sleep = async (ms: number) => {
    clock.at += ms;
    w.panes[0]!.agent_status = clock.at > T0 + 20_000 ? (workedEarlier ? "idle" : "working")
      : workedEarlier && clock.at === T0 + 2_000 ? "working" : "unknown";
  };
  expect(await startupPoll({ run: fakeRunner(w), clock: { ...clock, sleep } }, "hc:t1", async () => false)).toEqual({ verdict: "ok", detail: "ready" });
  expect(clock.at - T0).toBe(24_000);
  expect(sentText(w)).toEqual([]);
});

test("startupPoll counts slow hc calls against the budget and leaves permanent unknown unconfirmed", async () => {
  const w = world("unknown");
  w.screen = "loading\nstill loading\n❯ ";
  const clock = fakeClock(T0);
  const sleep = async (ms: number) => { clock.at += ms; };
  const hc = fakeRunner(w);
  const run: Runner = async (argv, opts) => {
    const limit = opts?.timeoutMs ?? Infinity;
    expect(limit).toBeGreaterThan(0);
    expect(clock.at - T0 + limit).toBeLessThanOrEqual(45_000);
    clock.at += Math.min(limit, 3_000);
    return hc(argv);
  };
  const v = await startupPoll({ run, clock: { ...clock, sleep } }, "hc:t1");
  expect(v).toEqual({ verdict: "unconfirmed", detail: "no ready agent status (unknown); last lines: loading / still loading / ❯" });
  expect(clock.at - T0).toBeWithin(40_000, 45_001);
  expect(sentText(w)).toEqual([]);
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
  expect(resumeArgv(["omo", "--model", "{model}"], "abc")).toBeUndefined();
  expect(resumeArgv(["omo", "{prompt}"], "--evil")).toBeUndefined();
  expect(resumeArgv(["omo", "{prompt}"], "a b")).toBeUndefined();
});
