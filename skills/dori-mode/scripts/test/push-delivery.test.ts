import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type DeliveryConfig, defaultConfig } from "../src/config.ts";
import type { Runner } from "../src/run.ts";
import { ACK_KEEP_MS, Supervisor } from "../src/supervise.ts";
import { inputState, pointerText } from "../src/supervise-push.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { recordAck, recordHandled } from "../src/ack.ts";
import { take, takeCarriedReminders, takeOutput } from "../src/inbox.ts";
import { resolveEventPolicy } from "../src/event-policy.ts";
import { recordReported, takeReminders } from "../src/lane-outcomes.ts";
import { readWakes } from "../src/store.ts";
import { depsFor, fakeClock, newWorld, readJournal, withState, writeJournal } from "./fakes.ts";
import { BUILT_IN } from "../src/tunables.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

type Delivery = Partial<Omit<DeliveryConfig, "push">> & { readonly push?: Partial<DeliveryConfig["push"]> };
const delivery = (patch: Delivery = {}): DeliveryConfig => {
  const base = BUILT_IN.delivery;
  return { ...base, ...patch, push: { ...base.push, ...patch.push } };
};

/** A screen as omo draws it (phase 0 capture): the input box between the running header and the full-width separator. */
const omo = (input: string, footer = "(\u{1F63A} OmO Native by Q Kim)"): string =>
  `\u2500\u2500 \u2022 Working (1s \u2022 esc to interrupt) ${"\u2500".repeat(40)}\n\u276f ${input}\n${"\u2500".repeat(80)}\n/repo \u2022 0/1M (0.0%) (auto)\n${footer}`;
const EMPTY = omo("");

const fixture = (extra: Record<string, unknown> = {}) => {
  const state = withState();
  cleanups.push(state.done);
  const clock: ReturnType<typeof fakeClock> = { at: 1_800_000_000_000, now: () => clock.at, sleep: async () => {} /* confirm waits inside sendVerified must not move the escalation clock: the "N min" in the handoff reason counts only the test's own steps */ };
  const world = newWorld();
  world.screen = EMPTY;
  const session = "11111111-1111-4111-8111-111111111111";
  const config = { sessionsDir: join(state.dir, "sessions"), leadCwd: "/repo", ...extra };
  const dir = sessionDirFor(config.sessionsDir, "/repo");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2027-01-15T08-00-00-000Z_${session}.jsonl`);
  writeFileSync(file, "{}\n");
  utimesSync(file, clock.now() / 1000, clock.now() / 1000);
  const pane = { pane_id: "lead:p1", workspace_id: "test", cwd: "/repo", agent: "omo", agent_status: "idle" };
  world.panes.push(pane);
  let active = session;
  let pid = 101;
  let prompt: string | undefined;
  let onEnter: string | undefined;
  let onSend: (() => void) | undefined;
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    const ok = (out = "") => ({ code: 0, out, err: "" });
    if (argv[0] === "ps" && argv[1] === "-A") return ok(pid ? `${pid} 10 /usr/bin/omo --session-id ${active}` : "");
    if (argv[0] === "ps" && argv[1] === "eww") return ok("PI_SESSION_ID=other");
    if (argv[0] === "herdr" && argv[2] === "list") return ok(JSON.stringify({ result: { panes: world.panes } }));
    if (argv[0] === "herdr" && argv[2] === "process-info") return ok(JSON.stringify({ result: { process_info: { shell_pid: 10, foreground_processes: pid ? [{ pid, argv: ["omo", "--session-id", active] }] : [] } } }));
    if (argv[0] === "kill") {
      if (argv[2] === String(pid)) { pid = 0; pane.agent = ""; pane.agent_status = ""; }
      return ok();
    }
    if (argv[0] === "herdr" && argv[2] === "run") {
      const path = /@([^'\s]+)/.exec(argv[4] ?? "")?.[1];
      prompt = path ? readFileSync(path, "utf8") : undefined;
      active = /--session-id ([\w-]+)/.exec(argv[4] ?? "")?.[1] ?? "";
      pid = 201;
      mkdirSync(join(dir, "session-holders", active), { recursive: true });
      writeFileSync(join(dir, "session-holders", active, `${pid}.json`), "{}");
      pane.agent = "omo";
      pane.agent_status = "idle";
      return ok();
    }
    if (argv[0] === "herdr" && argv[2] === "wait") return ok();
    if (argv[0] === "herdr" && argv[2] === "read") return ok(world.screens?.length ? (world.screens.shift() ?? world.screen) : world.screen);
    if (argv[0] === "herdr" && argv[2] === "send-text") { onSend?.(); return ok(); }
    if (argv[0] === "herdr" && argv[2] === "send-keys") {
      if (onEnter) pane.agent_status = onEnter;
      return ok();
    }
    throw new Error(`unexpected ${argv.join(" ")}`);
  };
  const deps = { ...depsFor(world, clock, state.dir, config), run };
  return {
    state, deps, pane, clock, calls, world, file,
    texts: () => calls.filter((call) => call[0] === "herdr" && call[2] === "send-text").map((call) => call[4] ?? ""),
    enters: () => calls.filter((call) => call[0] === "herdr" && call[2] === "send-keys").length,
    launches: () => calls.filter((call) => call[0] === "herdr" && call[2] === "run"),
    prompt: () => prompt,
    onEnter: (status: string | undefined) => { onEnter = status; },
    onSend: (hook: () => void) => { onSend = hook; },
  };
};

/** Console output of `work`, kept off the test log. */
const logged = async (work: () => Promise<unknown>): Promise<string[]> => {
  const lines: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try { await work(); } finally { console.log = log; console.error = error; }
  return lines;
};
const flush = (supervisor: Supervisor) => logged(() => supervisor.flush());

const inToolCall = (f: ReturnType<typeof fixture>, at: number): void => {
  const entry = (message: object, when: number) => JSON.stringify({ type: "message", timestamp: new Date(when).toISOString(), message });
  writeFileSync(f.file, `${entry({ role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "eval" }] }, at)}\n`);
};

test("an urgent event for an idle lead gets exactly one [dori] pointer and one Enter, its push journaled before the send", async () => {
  const f = fixture({ delivery: delivery() });
  f.onEnter("working");
  const supervisor = new Supervisor(f.deps);
  let journaled: unknown;
  f.onSend(() => { journaled = readJournal(f.state.dir).inbox?.push?.attempts; });
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  const lines = await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  const pointer = f.texts()[0] ?? "";
  expect(pointer.startsWith("[dori] supervisor: 1 new event (urgent: WAIT_DONE).")).toBe(true);
  expect(pointer.length).toBeLessThanOrEqual(200);
  expect(f.enters()).toBe(1);
  expect(journaled).toBe(1);
  expect(lines.some((line) => /^LEAD_PUSH \w+ 1 WAIT_DONE delivered attempt=1$/.test(line))).toBe(true);
});

test("a lone LANE_CLOSED (default policy, no INBOUND, no UNREPORTED) is logged and pushed to an idle lead at once, not after digestMaxDelayMin", async () => {
  const f = fixture({ delivery: delivery() });
  f.onEnter("working");
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha closed https://github.com/acme/app/pull/7");
  const lines = await flush(supervisor);
  expect(readFileSync(join(f.state.dir, "lead-events.log"), "utf8")).toContain('"id":"lane-closed:alpha"');
  expect(f.texts()).toHaveLength(1);
  expect(f.texts()[0]).toStartWith("[dori] supervisor: 1 new event (urgent: LANE_CLOSED).");
  expect(f.enters()).toBe(1);
  expect(lines.some((line) => /^LEAD_PUSH \w+ 1 LANE_CLOSED delivered attempt=1$/.test(line))).toBe(true);
});

test("a taken outcome still ends its reporting turn and pushes UNREPORTED before the timeout", async () => {
  const f = fixture({ delivery: delivery() });
  f.onEnter("working");
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("closed:alpha", "LANE_CLOSED alpha x");
  await flush(supervisor);
  expect(readJournal(f.state.dir).outcomes[0].deliveredAt).toBe(f.clock.now());
  expect(readJournal(f.state.dir).outcomes[0].deliveredWorking).toBe(true);
  take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() });
  f.pane.agent_status = "idle";
  f.clock.at += 2_000;
  await flush(supervisor);
  const reminders = readJournal(f.state.dir).events.filter((event: { line: string }) => event.line.startsWith("UNREPORTED "));
  expect(reminders).toHaveLength(1);
  expect(reminders[0].id).toBe(`unreported:alpha:${f.clock.now() - 2_000}:1`);
  expect(f.texts()).toHaveLength(2);
  expect(f.texts()[1]).toStartWith("[dori] supervisor: 1 new event (urgent: UNREPORTED; lanes: alpha).");
});

test("an untaken event is pushed again after ackSec though nothing is pending, and a take receipt past it stops the pushes", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 60 } }) });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  f.clock.at += 45_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(2);
  expect(takeOutput(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() }))).toEqual(["wait:1\tWAIT_DONE ci green"]);
  f.clock.at += 10 * 60_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(2);
  expect(readJournal(f.state.dir).inbox.push).toBeUndefined();
});

test("a re-push that starts an idle lead's turn is a wake; the pointer right after a warm append is not a second one", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 60 } }) });
  f.onEnter("working");
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  expect(readWakes(f.state.dir, 0)).toMatchObject([{ trigger: ["WAIT_DONE"], kinds: { WAIT_DONE: 1 } }]);
  // The lead ended that turn without taking: the re-push starts another one.
  f.pane.agent_status = "idle";
  f.clock.at += 45_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(2);
  expect(readWakes(f.state.dir, 0)).toMatchObject([{ trigger: ["WAIT_DONE"] }, { trigger: ["WAIT_DONE"], kinds: { WAIT_DONE: 1 } }]);
});

test("a burst within one tick and more within ackSec become a single push", async () => {
  const f = fixture({ delivery: delivery() });
  const supervisor = new Supervisor(f.deps);
  for (const i of [1, 2, 3]) supervisor.enqueue(`wait:${i}`, `WAIT_DONE job ${i}`);
  await flush(supervisor);
  f.clock.at += 5_000;
  supervisor.enqueue("lane:1", "LANE_REPORT k question which base?");
  supervisor.enqueue("lane:2", "LANE_REPORT k blocked no token");
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  expect(f.texts()[0]).toContain("3 new events (urgent: WAIT_DONE x3)");
});

test("a blocked lead is never typed into, a working one only with toWorking and after ackSec, and every state still appends", async () => {
  for (const [status, toWorking, pushes] of [["blocked", true, 0], ["working", false, 0], ["working", true, 1]] as const) {
    const f = fixture({ delivery: delivery({ push: { toWorking } }) });
    f.pane.agent_status = status;
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("wait:1", "WAIT_DONE ci green");
    await flush(supervisor);
    expect(readFileSync(join(f.state.dir, "lead-events.log"), "utf8")).toContain('"id":"wait:1"');
    expect(f.texts()).toEqual([]);
    f.clock.at += 45_000;
    await flush(supervisor);
    expect(f.texts()).toHaveLength(pushes);
    if (status === "blocked") expect(f.enters()).toBe(0);
    // A pointer queued into a working turn never confirms by a status change; its empty input needs no second Enter.
    if (status === "working" && toWorking) expect(f.enters()).toBe(1);
  }
});

test("a working lead that turns idle gets its pointer on the next pass", async () => {
  const f = fixture({ delivery: delivery() });
  f.pane.agent_status = "working";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  expect(f.texts()).toEqual([]);
  f.pane.agent_status = "idle";
  f.clock.at += 5_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
});

test("the input guard types only into an empty input, and re-submits only our own pointer or a lone paste placeholder", async () => {
  const pointer = pointerText(1, true, ["WAIT_DONE"], 200);
  // Wrapped the way omo wraps a long line: two-space continuation lines inside the box.
  const wrapped = omo(`${pointer.slice(0, 120)}\n  ${pointer.slice(120)}`);
  expect(inputState(EMPTY)).toBe("empty");
  expect(inputState(wrapped)).toBe("ours");
  expect(inputState(omo("[paste #1 +3 lines]"))).toBe("ours");
  expect(inputState(omo("[paste #1 +3 lines] and more"))).toBe("busy");
  expect(inputState(omo("half a sentence"))).toBe("busy");
  expect(inputState(omo("\n  second line of the owner's text"))).toBe("busy");
  expect(inputState("no prompt on this screen")).toBe("busy");
  for (const [screen, texts, enters, line] of [
    [omo("half a sentence"), 0, 0, "LEAD_PUSH_INPUT_BUSY"],
    [omo("\n  second line"), 0, 0, "LEAD_PUSH_INPUT_BUSY"],
    [wrapped, 0, 1, "LEAD_PUSH_ENTER_RETRY"],
    [omo("[paste #1 +3 lines]"), 0, 1, "LEAD_PUSH_ENTER_RETRY"],
    [omo("[paste #1 +3 lines] and more"), 0, 0, "LEAD_PUSH_INPUT_BUSY"],
  ] as const) {
    const f = fixture({ delivery: delivery() });
    f.world.screen = screen;
    const supervisor = new Supervisor(f.deps);
    supervisor.enqueue("wait:1", "WAIT_DONE ci green");
    const lines = await flush(supervisor);
    expect([f.texts().length, f.enters()]).toEqual([texts, enters]);
    expect(lines.some((l) => l.startsWith(line))).toBe(true);
  }
});

test("a pushed pointer still in the input after pasteCheckMs gets one more Enter, never a second one", async () => {
  const f = fixture({ delivery: delivery() });
  const pointer = pointerText(1, true, ["WAIT_DONE"], 200);
  // The input is empty until the send; then the pointer stays visible until the extra Enter.
  f.onSend(() => { f.world.screen = omo(pointer); });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  expect(f.enters()).toBe(2);
});

test("an untaken urgent event survives a ladder restart: the cursor stays, take prints it and preserves owner recovery text, the prompt neither", async () => {
  const f = fixture({ delivery: delivery({ tailMonitor: false }) });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 please fix the build");
  supervisor.enqueue("lane:q", "LANE_REPORT k question which base branch?");
  await flush(supervisor);
  // The owner message is acked (the lead read it on its tail), so only the lane question is untaken.
  recordAck(f.state.dir, "1", "1", f.clock.now());
  supervisor.ackTick(60_000);
  const before = readJournal(f.state.dir).inbox.takenOffset;
  for (let i = 0; i < 6 && !f.launches().length; i++) {
    f.clock.at += 60_000;
    await flush(supervisor);
  }
  expect(f.launches()).toHaveLength(1);
  expect(readJournal(f.state.dir).inbox.takenOffset).toBe(before);
  const prompt = f.prompt() ?? "";
  const lines = prompt.split("\n");
  expect(lines[3]).toStartWith("Run dori inbox take now");
  expect(prompt).toContain("it did not take pushed events (1 urgent event(s) untaken for 5 min)");
  expect(prompt).not.toContain("discord:1:1");
  expect(prompt).not.toContain("lane:q");
  expect(prompt).not.toContain("tail -c +");
  expect(takeOutput(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() }))).toEqual([
    "discord:1:1\tINBOUND 1 1 please fix the build", "lane:q\tLANE_REPORT k question which base branch?",
  ]);
  // The take itself now preserves owner text before its receipt, including after a cold start.
  expect(takeCarriedReminders(f.state.dir)).toEqual([expect.stringContaining("INBOUND 1 1 please fix the build")]);
  expect(readJournal(f.state.dir).forcedRestarts).toEqual([{ at: expect.any(Number), cause: "forced" }]);
});

test("a new lead is not escalated before escalateMin after its start, and gets a pointer first (N1)", async () => {
  const f = fixture({ delivery: delivery({ tailMonitor: false }) });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("lane:q", "LANE_REPORT k question which base branch?");
  await flush(supervisor);
  for (let i = 0; i < 6 && !f.launches().length; i++) {
    f.clock.at += 60_000;
    await flush(supervisor);
  }
  expect(f.launches()).toHaveLength(1);
  // The new lead did not take: the pass that started it already gave it a pointer, and no second restart follows for escalateMin.
  const launched = f.calls.findIndex((call) => call[2] === "run");
  expect(f.calls.findLastIndex((call) => call[2] === "send-text")).toBeGreaterThan(launched);
  for (let i = 0; i < 4; i++) {
    f.clock.at += 60_000;
    await flush(supervisor);
  }
  expect(f.launches()).toHaveLength(1);
  f.clock.at += 61_000;
  await flush(supervisor);
  expect(f.launches()).toHaveLength(2);
});

test("a finished lane taken but not reported keeps an idle lead pushed and escalates it like an untaken urgent event; dori reported ends it", async () => {
  const f = fixture({ cacheTtlMin: 60, delivery: delivery({ tailMonitor: false }), eventPolicy: resolveEventPolicy({ kinds: { LANE_CLOSED: "lead-urgent" } }) });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha merged");
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  expect(takeOutput(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() }))).toEqual(["lane-closed:alpha\tLANE_CLOSED alpha merged"]);
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  // Taken, yet past reportTimeoutMin it is pushed again with nothing untaken in the log.
  f.clock.at += 5 * 60_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(2);
  expect(f.texts()[1]).toStartWith("[dori] supervisor: 1 new event (urgent: UNREPORTED; lanes: alpha).");
  // The supervisor now journals the timeout reminder during flush; take it so the ladder below tests the report debt.
  expect(takeOutput(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() }))?.[0]).toStartWith(`unreported:alpha:${f.clock.now() - 5 * 60_000}:1\tUNREPORTED alpha `);
  for (let i = 0; i < 8 && !f.launches().length; i++) {
    f.clock.at += 60_000;
    await flush(supervisor);
  }
  expect(f.launches()).toHaveLength(1);
  const prompt = f.prompt() ?? "";
  expect(prompt).toContain("it did not take pushed events (1 finished lane(s) not reported to the owner for 5 min)");
  // The prompt carries no obligation line: the new lead's take prints it as a reminder.
  expect(prompt).not.toContain("UNREPORTED alpha");
  expect(takeReminders(f.state.dir)).toEqual([expect.stringMatching(/^unreported:alpha\tUNREPORTED alpha since /)]);
  recordReported(f.state.dir, "alpha", f.clock.now());
  await supervisor.reportTick();
  const pushed = f.texts().length;
  for (let i = 0; i < 12; i++) {
    f.clock.at += 60_000;
    await flush(supervisor);
  }
  expect(f.texts()).toHaveLength(pushed);
  expect(f.launches()).toHaveLength(1);
});

test("with the tail monitor on, an acked owner message leaves the untaken set and never restarts; other events only re-push", async () => {
  const f = fixture({ delivery: delivery() });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  recordAck(f.state.dir, "1", "1", f.clock.now());
  supervisor.ackTick(60_000);
  for (let i = 0; i < 10; i++) {
    f.clock.at += 60_000;
    await flush(supervisor);
  }
  expect(f.texts()).toHaveLength(1);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  for (let i = 0; i < 10; i++) {
    // A lead in use keeps a fresh session file, so delivery stays warm instead of cold-starting it.
    utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
    await flush(supervisor);
    f.clock.at += 60_000;
  }
  expect(f.texts().length).toBeGreaterThan(2);
  expect(f.launches()).toEqual([]);
});

test("with the tail monitor on, an owner message unacked for escalateMin restarts an idle lead (the idle rule's clock is the ladder's)", async () => {
  const f = fixture({ delivery: delivery() });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await flush(supervisor);
  f.clock.at += 2 * 60_000;
  await flush(supervisor);
  expect(f.launches()).toEqual([]);
  f.clock.at += 3 * 60_000;
  await flush(supervisor);
  expect(f.launches()).toHaveLength(1);
});

test("the ladder's safety restart does not wait for the lead's running child, and its log names the child it stops", async () => {
  const f = fixture({ delivery: delivery() });
  const since = new Date(f.clock.now()).toISOString();
  writeFileSync(f.file, `${JSON.stringify({ type: "custom", customType: "session-lifecycle", timestamp: since, data: { state: "waiting_children", since, waitingOn: { children: 1, background: [], human: [] } } })}\n`);
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await flush(supervisor);
  f.clock.at += 5 * 60_000;
  const lines = await flush(supervisor);
  expect(f.launches()).toHaveLength(1);
  expect(lines.filter((line) => line.startsWith("LEAD_RESTART_TRIGGER push-escalate ") && line.endsWith("; stops 1 child task(s) the lead was waiting on"))).toHaveLength(1);
});

test("an owner message the lead took but did not ack still restarts an idle lead in push mode", async () => {
  const f = fixture({ delivery: delivery() });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await flush(supervisor);
  take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() });
  f.clock.at += 5 * 60_000;
  await flush(supervisor);
  expect(f.launches()).toHaveLength(1);
  expect(takeCarriedReminders(f.state.dir).join("\n")).toContain("INBOUND 1 1 hi");
});

test.each([false, true])("a mixed take followed by only the lane receipt keeps the owner pushed across supervisor restart (tail=%s)", async (tailMonitor) => {
  const f = fixture({ delivery: delivery({ tailMonitor }), cacheTtlMin: 60 });
  let supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 please reply");
  supervisor.enqueue("lane-closed:alpha", "LANE_CLOSED alpha merged");
  await flush(supervisor);
  expect(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() }).events.map((event) => event.id))
    .toEqual(["discord:1:1", "lane-closed:alpha"]);
  recordReported(f.state.dir, "alpha", f.clock.now());
  await supervisor.reportTick();
  supervisor.close();
  supervisor = new Supervisor(f.deps);
  f.clock.at += 60_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(2);
  expect(f.texts()[1]).toContain("urgent: INBOUND");
  expect(takeCarriedReminders(f.state.dir).join("\n")).toContain("INBOUND 1 1 please reply");
  // Repeated takes must not keep resetting the escalation clock.
  supervisor.enqueue("wait:more", "WAIT_DONE more");
  await flush(supervisor);
  take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() });
  f.clock.at += 4 * 60_000;
  await flush(supervisor);
  expect(f.launches()).toHaveLength(1);
  recordHandled(f.state.dir, "1", "1", f.clock.now(), { all: true });
  supervisor.ackTick(60_000);
  const pushed = f.texts().length;
  f.clock.at += 60_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(pushed);
  expect(takeCarriedReminders(f.state.dir)).toEqual([]);
  supervisor.close();
});

test.each([false, true])("an acked owner still pushes and escalates after its one UNHANDLED reminder was taken (tail=%s)", async (tailMonitor) => {
  const f = fixture({ delivery: delivery({ tailMonitor }), handledTimeoutMin: 1, cacheTtlMin: 60 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 unfinished");
  await flush(supervisor);
  take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() });
  recordAck(f.state.dir, "1", "1", f.clock.now());
  supervisor.ackTick(60_000);
  f.clock.at += 60_000;
  supervisor.handledTick();
  await flush(supervisor);
  expect(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() }).events.map((event) => event.line))
    .toEqual([expect.stringMatching(/^UNHANDLED 1 1 /)]);
  f.clock.at += 60_000;
  await flush(supervisor);
  expect(f.texts().at(-1)).toContain("urgent: UNHANDLED");
  f.clock.at += 4 * 60_000;
  await flush(supervisor);
  expect(f.launches()).toHaveLength(1);
  expect(readJournal(f.state.dir).events.filter((event: { line: string }) => event.line.startsWith("UNHANDLED "))).toHaveLength(1);
  supervisor.close();
});

test("a working lead is never ladder-restarted for a non-owner event, but one tool call with an unacked owner message is, on escalateMin", async () => {
  const progressing = fixture({ delivery: delivery({ tailMonitor: false }) });
  progressing.pane.agent_status = "working";
  const s1 = new Supervisor(progressing.deps);
  s1.enqueue("gh:1", "GH_PR acme/app#7 comment please rename");
  for (let i = 0; i < 12; i++) {
    progressing.world.screen = omo(`step ${"x".repeat(i)}`);
    await flush(s1);
    progressing.clock.at += 60_000;
  }
  expect(progressing.launches()).toEqual([]);

  const held = fixture({ delivery: delivery() });
  held.pane.agent_status = "working";
  inToolCall(held, held.clock.now());
  const s2 = new Supervisor(held.deps);
  s2.enqueue("discord:1:1", "INBOUND 1 1 hi");
  for (let i = 0; i < 5; i++) {
    await flush(s2);
    held.clock.at += 60_000;
  }
  expect(held.launches()).toEqual([]);
  await flush(s2);
  expect(held.launches()).toHaveLength(1);
  expect(held.prompt()).toContain("it was stuck in one tool call for 5 min");
});

test("past restartMaxPerHour the ladder refuses, logs and tells the owner once, keeps re-pushing, and the cap survives a supervisor restart", async () => {
  const f = fixture({ delivery: delivery({ tailMonitor: false }) });
  writeJournal(f.state.dir, { events: [], forcedRestarts: [1, 2, 3].map((i) => ({ at: f.clock.now() - i * 60_000, cause: "forced" })) });
  const announced: string[] = [];
  const hooks = { announce: async (text: string) => { announced.push(text); } };
  let supervisor = new Supervisor(f.deps, hooks);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  const lines: string[] = [];
  for (let i = 0; i < 8; i++) {
    lines.push(...await flush(supervisor));
    f.clock.at += 60_000;
    if (i === 5) { supervisor.close(); supervisor = new Supervisor(f.deps, hooks); }
  }
  await supervisor.reactionsSettled();
  expect(f.launches()).toEqual([]);
  expect(lines.filter((line) => line.startsWith("LEAD_RESTART_CAPPED"))).toHaveLength(1);
  expect(announced.filter((text) => text.includes("다시 재시작하지 않습니다"))).toHaveLength(1);
  expect(f.texts().length).toBeGreaterThan(3);
  // The lead hears why nobody restarts it: one urgent LEAD_UNRESPONSIVE per hour, named in its next pointer; it
  // reaches a stale idle lead in place, never as a cold start the cap would not allow.
  const unresponsive = readJournal(f.state.dir).events.filter((event: { line: string }) => event.line.startsWith("LEAD_UNRESPONSIVE "));
  expect(unresponsive).toHaveLength(1);
  expect(unresponsive[0].line).toContain("push ladder");
  expect(readFileSync(join(f.state.dir, "lead-events.log"), "utf8")).toContain("LEAD_UNRESPONSIVE push ladder");
  expect(f.texts().some((text) => text.includes("LEAD_UNRESPONSIVE"))).toBe(true);
});

test("the cap counts forced restarts only: a demand-driven cold start is not counted (N4)", async () => {
  const f = fixture({ delivery: delivery() });
  const supervisor = new Supervisor(f.deps);
  // A stale idle session with no waits or lanes is not warm: the urgent event goes to a cold start.
  f.clock.at += 10 * 60_000;
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  expect(f.launches()).toHaveLength(1);
  expect(readJournal(f.state.dir).forcedRestarts).toBeUndefined();
});

test("compacted owner tracking counts as taken: no push, no escalation (N2)", async () => {
  const f = fixture({ delivery: delivery({ tailMonitor: false }) });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await flush(supervisor);
  recordAck(f.state.dir, "1", "1", f.clock.now());
  recordHandled(f.state.dir, "1", "1", f.clock.now(), { reply: true });
  supervisor.ackTick(60_000);
  f.clock.at += ACK_KEEP_MS + 60_000;
  supervisor.ackTick(60_000);
  expect(readJournal(f.state.dir).closedOwners).toContain("discord:1:1");
  for (let i = 0; i < 3; i++) {
    await flush(supervisor);
    f.clock.at += 10 * 60_000;
  }
  expect(f.texts()).toHaveLength(1);
  expect(f.launches()).toEqual([]);
});

test("an edit after the ack and a delete of an acked message are pushed; a delete of a never-acked message is not (N3)", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 60 } }) });
  const supervisor = new Supervisor(f.deps);
  const takeAll = () => take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() });
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  supervisor.enqueue("discord:1:2", "INBOUND 1 2 other");
  await flush(supervisor);
  recordAck(f.state.dir, "1", "1", f.clock.now());
  supervisor.ackTick(60_000);
  takeAll();
  f.clock.at += 1_000;
  supervisor.enqueue("discord:1:1:edit:1", "INBOUND_EDIT 1 1 new text");
  await flush(supervisor);
  expect(f.texts().at(-1)).toContain("INBOUND_EDIT");
  takeAll();
  supervisor.enqueue("discord:1:1:delete", "INBOUND_DELETE 1 1");
  await flush(supervisor);
  expect(f.texts().at(-1)).toContain("INBOUND_DELETE");
  takeAll();
  const pushes = f.texts().length;
  supervisor.enqueue("discord:1:2:delete", "INBOUND_DELETE 1 2");
  await flush(supervisor);
  expect(f.texts()).toHaveLength(pushes);
});

test("after retries + 1 pushes the next one waits twice ackSec (N7)", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 60 } }) });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  for (let i = 0; i < 2; i++) {
    f.clock.at += 45_000;
    await flush(supervisor);
  }
  expect(f.texts()).toHaveLength(3);
  f.clock.at += 45_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(3);
  f.clock.at += 45_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(4);
});

test("digest traffic is pushed only once overdue, and a _WARN line never", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 120 } }), digestMaxDelayMin: 60 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("nudge:1", "NUDGED lane silent");
  supervisor.enqueue("warn:1", "SWEEP_WARN guard slow");
  await flush(supervisor);
  expect(f.texts()).toEqual([]);
  f.clock.at += 61 * 60_000;
  // Stale session: keep the lead warm so the overdue digest is appended, not cold-started.
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  expect(f.texts()[0]).toContain("(digest: NUDGED)");
});

test("a noise-only batch keeps one pointer at its take cursor: never typed again, idle or working, until a take", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 120 } }), digestMaxDelayMin: 60 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("nudge:1", "NUDGED lane silent");
  f.clock.at += 61 * 60_000;
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  for (const status of ["idle", "working", "idle", "working"]) {
    f.pane.agent_status = status;
    f.clock.at += 11 * 60_000;
    utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
    supervisor.enqueue(`nudge:${f.clock.now()}`, "NUDGED lane silent");
    await flush(supervisor);
  }
  expect(f.texts()).toHaveLength(1);
  expect(f.launches()).toHaveLength(0);
  take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() });
  supervisor.enqueue("nudge:after", "NUDGED lane silent");
  f.clock.at += 61 * 60_000;
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  f.pane.agent_status = "idle";
  await flush(supervisor);
  expect(f.texts()).toHaveLength(2);
});

test("an actionable event joining a pointed noise-only batch still retries after ackSec and escalates an idle lead", async () => {
  const f = fixture({ delivery: delivery({ tailMonitor: false }), digestMaxDelayMin: 60 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("nudge:1", "NUDGED lane silent");
  f.clock.at += 61 * 60_000;
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  f.clock.at += 60_000;
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  expect(f.texts()).toHaveLength(2);
  expect(f.texts()[1]).toContain("urgent: WAIT_DONE");
  f.clock.at += 45_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(3);
  for (let i = 0; i < 10 && !f.launches().length; i++) {
    f.clock.at += 60_000;
    await flush(supervisor);
  }
  expect(f.launches()).toHaveLength(1);
});

test("a first runner disconnect waits in the digest batch; an owner message arriving meanwhile is pushed at once and carries it", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 120 } }), digestMaxDelayMin: 60 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("runner:offline:1", "RUNNER_OFFLINE machine=mac runner heartbeat missing for 180 s");
  await flush(supervisor);
  expect(f.texts()).toEqual([]);
  f.clock.at += 5 * 60_000;
  // Keep the lead warm so the push is appended, not a cold start.
  utimesSync(f.file, f.clock.now() / 1000, f.clock.now() / 1000);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 is the build done?");
  await flush(supervisor);
  // One pointer for both: the owner message and the batched disconnect the same take prints.
  expect(f.texts()).toHaveLength(1);
  expect(f.texts()[0]).toContain("2 new events (urgent: INBOUND)");
});

test("push mode enqueues no ACK_MISSING but the owner still gets the ack notice", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 60 } }), ackTimeoutSec: 60 });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await flush(supervisor);
  f.clock.at += 61_000;
  expect(supervisor.ackTick(60_000)).toEqual([]);
  f.clock.at += 61_000;
  expect(supervisor.ackTick(60_000)).toEqual([{ channel: "1", message: "1" }]);
  expect(readJournal(f.state.dir).events.some((event: { line: string }) => event.line.startsWith("ACK_MISSING"))).toBe(false);
});

test("nothing untaken and due makes no herdr call at all", async () => {
  const f = fixture({ delivery: delivery() });
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() });
  const before = f.calls.length;
  f.clock.at += 60_000;
  await flush(supervisor);
  expect(f.calls.slice(before)).toEqual([]);
});

test("a crash between the journaled push and the send pushes once more after ackSec", async () => {
  const f = fixture({ delivery: delivery({ push: { escalateMin: 60 } }) });
  let crash = true;
  f.onSend(() => { if (crash) { crash = false; throw new Error("killed mid-send"); } });
  const first = new Supervisor(f.deps);
  first.enqueue("wait:1", "WAIT_DONE ci green");
  await expect(logged(() => first.flush())).rejects.toThrow("killed mid-send");
  first.close();
  const second = new Supervisor(f.deps);
  await flush(second);
  expect(f.texts()).toHaveLength(1);
  f.clock.at += 45_000;
  await flush(second);
  expect(f.texts()).toHaveLength(2);
});

test("a journal written under the old tail mode moves the take cursor to the log's end on the first push start; a restart keeps it (N6)", async () => {
  const f = fixture();
  const first = new Supervisor(f.deps);
  first.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(first);
  first.close();
  const journal = readJournal(f.state.dir);
  writeJournal(f.state.dir, { ...journal, inbox: { ...journal.inbox, mode: "tail+tail", takenOffset: 0, push: undefined } });
  const lines = await logged(async () => { new Supervisor(f.deps).close(); });
  expect(lines.some((line) => line.startsWith("INBOX_CURSOR_ADVANCED 0 -> "))).toBe(true);
  expect(takeOutput(take(f.state.dir, { maxBytes: 16_384, now: f.clock.now(), peek: true }))).toEqual(["INBOX_EMPTY"]);
  const again = await logged(async () => { new Supervisor(f.deps).close(); });
  expect(again.some((line) => line.startsWith("INBOX_CURSOR_ADVANCED"))).toBe(false);
});

test("by default a working lead gets the pointer once its events waited ackSec, only into an empty input box", async () => {
  expect(BUILT_IN.delivery.push.toWorking).toBe(true);
  const f = fixture({ delivery: delivery() });
  f.pane.agent_status = "working";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("discord:1:1", "INBOUND 1 1 hi");
  await flush(supervisor);
  f.clock.at += 44_000;
  await flush(supervisor);
  expect(f.texts()).toEqual([]);
  // The owner's own draft sits in the input: nothing is typed over it, however long the events wait.
  f.world.screen = omo("half-typed owner text");
  f.clock.at += 1_000;
  const busy = await flush(supervisor);
  expect(f.texts()).toEqual([]);
  expect(f.enters()).toBe(0);
  expect(busy.some((line) => line.startsWith("LEAD_PUSH_INPUT_BUSY "))).toBe(true);
  f.world.screen = EMPTY;
  f.clock.at += 45_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  expect(f.texts()[0]).toStartWith("[dori] supervisor: 1 new event (urgent: INBOUND).");
});

test("a take restarts a working lead's ackSec wait: a newer event is not typed at once", async () => {
  const f = fixture({ delivery: delivery() });
  f.pane.agent_status = "working";
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("wait:1", "WAIT_DONE ci green");
  await flush(supervisor);
  f.clock.at += 45_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  take(f.state.dir, { maxBytes: 16_384, now: f.clock.now() });
  supervisor.enqueue("wait:2", "WAIT_DONE deploy done");
  f.clock.at += 5_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(1);
  f.clock.at += 45_000;
  await flush(supervisor);
  expect(f.texts()).toHaveLength(2);
});

test("the pointer names the lanes its events concern (meta.lane, UNREPORTED), cut to fit maxChars", async () => {
  const f = fixture({ delivery: delivery() });
  f.onEnter("working");
  const supervisor = new Supervisor(f.deps);
  supervisor.enqueue("r:1", "LANE_REPORT alpha question which base?", { lane: "alpha" });
  supervisor.enqueue("r:2", "LANE_REPORT beta blocked no token", { lane: "beta" });
  supervisor.enqueue("r:3", "LANE_REPORT alpha blocked again", { lane: "alpha" });
  await flush(supervisor);
  expect(f.texts()).toEqual(["[dori] supervisor: 3 new events (urgent: LANE_REPORT x3; lanes: alpha, beta). Not an owner message. Run dori inbox take, then continue your task."]);
  expect(pointerText(1, true, ["WAIT_DONE"], 200)).toBe("[dori] supervisor: 1 new event (urgent: WAIT_DONE). Not an owner message. Run dori inbox take, then continue your task.");
  const lanes = Array.from({ length: 12 }, (_, i) => `lane-number-${i}`);
  const cut = pointerText(12, true, ["LANE_REPORT"], 200, lanes);
  expect(cut.length).toBeLessThanOrEqual(200);
  expect(cut).toContain("lanes: lane-number-0");
  expect(cut).toMatch(/\+\d+ more\)\. Not an owner message/);
});

test("a working lead whose session file cannot be resolved is restarted on the escalateMin clock, not after 30 min", async () => {
  const unresolved = fixture({ delivery: delivery() });
  unresolved.pane.agent_status = "working";
  unlinkSync(unresolved.file);
  const s1 = new Supervisor(unresolved.deps);
  s1.enqueue("discord:1:1", "INBOUND 1 1 hi");
  for (let i = 0; i < 5; i++) {
    await flush(s1);
    unresolved.clock.at += 60_000;
  }
  expect(unresolved.launches()).toEqual([]);
  await flush(s1);
  expect(unresolved.launches()).toHaveLength(1);
  expect(unresolved.prompt()).toContain("it was stuck with its session unresolved for 5 min");

  // Resolved and outside any tool call, the same busy lead is left to the 30 min rule.
  const resolved = fixture({ delivery: delivery() });
  resolved.pane.agent_status = "working";
  const s2 = new Supervisor(resolved.deps);
  s2.enqueue("discord:1:1", "INBOUND 1 1 hi");
  for (let i = 0; i < 7; i++) {
    await flush(s2);
    resolved.clock.at += 60_000;
  }
  expect(resolved.launches()).toEqual([]);
});
