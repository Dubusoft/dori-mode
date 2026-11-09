import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { DEFAULT_EVENT_POLICY, eventClass, eventKind, EventPolicyError, resolveEventPolicy } from "../src/event-policy.ts";
import { eventPriority } from "../src/supervise.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

/** The hard-coded classifier this table replaced (supervise-delivery.ts before 1.7), kept verbatim as the reference. */
const LEGACY_URGENT = [
  "INBOUND", "INBOUND_EDIT", "INBOUND_DELETE", "VISITOR", "LANE_DONE_CLAIMED", "LANE_NOT_DONE", "LANE_CLOSED", "LANE_REPORT",
  "DEAD_PANE", "UNRECOGNISED_PANE", "NO-PROGRESS",
  "HOST_GUARD ALERT", "HOST_GUARD CLEAR", "LAUNCH_READY", "WORKING-WHILE-PAUSED",
  "WAIT_DONE", "WAIT_TIMEOUT", "SUPERVISOR_STUCK", "ACK_MISSING", "UNHANDLED",
  "LANE_RECOVERY_EXHAUSTED",
  "WAIT_FAILED", "WAITS_CORRUPT",
  "TASK_STALLED",
];
const legacyPriority = (line: string): "urgent" | "digest" =>
  LEGACY_URGENT.some((prefix) => line === prefix || line.startsWith(`${prefix} `)) ||
  /^GH_PR \S+ (checks_failing|merged|closed|review|comment|conflicting)(?: |$)/.test(line) ||
  /^GH_ISSUE \S+ (opened|reopened) /.test(line) ? "urgent" : "digest";

const corpus = [
  ...LEGACY_URGENT.flatMap((kind) => [kind, `${kind} detail here`, `${kind}X detail`, `${kind}_MORE detail`]),
  ...["checks_failing", "merged", "closed", "review", "comment", "conflicting", "opened", "updated", "checks_green", "merged_x"]
    .flatMap((kind) => [`GH_PR acme/app#7 ${kind} sha=abc https://github.com/acme/app/pull/7`, `GH_PR acme/app#7 ${kind}`]),
  "GH_PR merged", "GH_PR acme/app#7", "GH_ISSUE acme/app#3 opened author=a https://x", "GH_ISSUE acme/app#3 reopened author=a https://x",
  "GH_ISSUE acme/app#3 closed author=a https://x", "GH_ISSUE_UNTRUSTED acme/app#3 opened author=b https://x",
  "HOST_GUARD", "HOST_GUARD WARN x", "HOST_GUARD ALERTS x", "SWEEP_WARN watch boom", "MEMORY_CHECK stale", "PROGRESS lane x", "NUDGED lane",
  "OWNER_QUARANTINED 2 1:2,3", "COMPUTE_READY", "", " INBOUND leading space", "inbound lower case", "NEW_SOURCE_KIND something",
];

test("the default table classifies every line as the hard-coded list did, except the events the supervisor settles itself", () => {
  const differ = corpus.filter((line) => eventPriority(line) !== legacyPriority(line));
  // CI follow-up messages the lane about failing checks and conflicts first, and a merged PR is read back by the
  // supervisor: for the lead these are digest. The done claim and the lane close are urgent like LEGACY_URGENT.
  // ACK_MISSING is no longer enqueued (push delivery re-pushes unacked owner messages): an old journal's line is digest.
  expect(differ).toEqual(corpus.filter((line) => /^GH_PR \S+ (checks_failing|conflicting|merged)(?: |$)/.test(line) || /^ACK_MISSING( |$)/.test(line)));
  expect(differ.every((line) => eventPriority(line) === "digest")).toBe(true);
  expect(corpus.filter((line) => eventPriority(line) === "urgent").length).toBeGreaterThan(LEGACY_URGENT.length);
});

test("the done claim and lane-ending events, a close after a received claim too, are lead-urgent; the merge readback stays lead-digest", () => {
  for (const line of ["LANE_DONE_CLAIMED alpha w:p1 proof", "LANE_CLOSED alpha closed", "LANE_CLOSED alpha closed seen-claim https://x", "LANE_CLOSED alpha closed seen-claim", "LANE_AUTO_CLOSED alpha {}", "CI_MERGED acme/app#7 into dev lane=alpha head=abc merge=def https://x"]) {
    expect(eventClass(line)).toBe("lead-urgent");
  }
  for (const line of ["MERGE_VERIFIED acme/app#7 into dev lane=alpha merge=def https://x", "GH_PR acme/app#7 merged sha=abc"]) {
    expect(eventClass(line)).toBe("lead-digest");
  }
});

test("a worker machine going OFFLINE or OUTDATED wakes the lead; NOT_INSTALLED, CURRENT and ONLINE are digest", () => {
  expect(eventClass("HOST_GUARD OFFLINE machine=mac unreachable: timeout")).toBe("lead-urgent");
  expect(eventClass("HOST_GUARD OUTDATED machine=mac have=a want=b; run dori update")).toBe("lead-urgent");
  expect(eventClass("HOST_GUARD NOT_INSTALLED machine=mac guard agent not installed; run dori guard install --machine mac")).toBe("lead-digest");
  expect(eventClass("HOST_GUARD CURRENT machine=mac abcdef012345")).toBe("lead-digest");
  expect(eventClass("HOST_GUARD ONLINE machine=mac")).toBe("lead-digest");
  // Digest even under a config whose default is urgent.
  expect(eventClass("HOST_GUARD NOT_INSTALLED machine=mac x", resolveEventPolicy({ default: "lead-urgent" }))).toBe("lead-digest");
});

test("LEAD_UNRESPONSIVE (restart cap refused) wakes the lead; a leftover ACK_MISSING line is digest", () => {
  expect(eventClass("LEAD_UNRESPONSIVE push ladder: you did not take pushed events")).toBe("lead-urgent");
  expect(eventClass("ACK_MISSING 1 2 hi")).toBe("lead-digest");
  expect(Object.keys(DEFAULT_EVENT_POLICY.kinds)).not.toContain("ACK_MISSING");
});

test("a kind is the most specific matching entry, else the line's first word", () => {
  expect(eventKind("GH_PR acme/app#7 merged sha=1")).toBe("GH_PR * merged");
  expect(eventKind("GH_PR acme/app#7 opened")).toBe("GH_PR");
  expect(eventKind("HOST_GUARD ALERT load")).toBe("HOST_GUARD ALERT");
  expect(eventKind("INBOUND 1 2 hi")).toBe("INBOUND");
  expect(eventKind("")).toBe("(empty)");
  const policy = resolveEventPolicy({ kinds: { "GH_PR acme/app#7 merged": "engine-only", "GH_PR * merged": "lead-digest" } });
  expect(eventKind("GH_PR acme/app#7 merged", policy)).toBe("GH_PR acme/app#7 merged");
  expect(eventClass("GH_PR acme/app#7 merged", policy)).toBe("engine-only");
  expect(eventClass("GH_PR other/x#1 merged", policy)).toBe("lead-digest");
});

test("LANE_REPORT_LATE follows LANE_REPORT: question, blocked and done are urgent, every other kind digest", () => {
  for (const kind of ["question", "blocked", "done"]) expect(eventClass(`LANE_REPORT_LATE gone-lane ${kind} text`)).toBe("lead-urgent");
  for (const kind of ["progress", "milestone", "other"]) expect(eventClass(`LANE_REPORT_LATE gone-lane ${kind} text`)).toBe("lead-digest");
  expect(eventKind("LANE_REPORT_LATE gone-lane question q")).toBe("LANE_REPORT_LATE * question");
  // An open decision's reminder wakes the lead like UNREPORTED and UNHANDLED do.
  expect(eventClass("UNRESOLVED wait:1 WAIT_DONE alpha ci green")).toBe("lead-urgent");
});

test("an eventPolicy in the config file is ignored: the built-in table holds", async () => {
  const state = withState();
  cleanups.push(state.done);
  const path = join(state.dir, "config.json");
  for (const eventPolicy of [{ default: "lead-urgent", kinds: { NUDGED: "engine-only" } }, 7]) {
    writeFileSync(path, JSON.stringify({ eventPolicy }));
    expect((await loadConfig(path, state.dir)).eventPolicy).toBe(DEFAULT_EVENT_POLICY);
  }
});

test("an old config's removed owner-only class loads as lead-digest, named in one warning per process", async () => {
  const state = withState();
  cleanups.push(state.done);
  const policy = { default: "owner-only", kinds: { DEPLOY: "owner-only", NUDGED: "engine-only" } };
  const script = `const { eventClass, resolveEventPolicy } = await import(${JSON.stringify(join(import.meta.dir, "../src/event-policy.ts"))});
    const a = resolveEventPolicy(${JSON.stringify(policy)});
    const b = resolveEventPolicy(${JSON.stringify(policy)});
    console.log(JSON.stringify([a.default, eventClass("DEPLOY web", a), eventClass("NUDGED x", a), b.default, eventClass("DEPLOY web", b)]));`;
  const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DORI_STATE_DIR: state.dir } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual(["lead-digest", "lead-digest", "engine-only", "lead-digest", "lead-digest"]);
  expect(err.split("\n").filter((line) => line.startsWith("EVENT_POLICY_"))).toEqual([
    "EVENT_POLICY_OWNER_ONLY_REMOVED default, DEPLOY: the owner-only class was removed (the supervisor no longer posts events to the owner); treated as lead-digest",
  ]);
});

test.each([
  [{ default: "urgent" }, "eventPolicy.default"],
  [{ kinds: { NUDGED: "loud" } }, "NUDGED"],
  [{ kinds: { "* merged": "lead-urgent" } }, "* merged"],
  [{ kinds: { "GH_PR  merged": "lead-urgent" } }, "GH_PR  merged"],
  [{ kinds: { INBOUND: "engine-only" } }, "owner messages must reach the lead"],
  [{ kinds: ["INBOUND"] }, "eventPolicy.kinds"],
  ["lead-urgent", "eventPolicy must be an object"],
])("a malformed eventPolicy %j is refused", (raw, message) => {
  expect(() => resolveEventPolicy(raw)).toThrow(EventPolicyError);
  expect(() => resolveEventPolicy(raw)).toThrow(message);
});
