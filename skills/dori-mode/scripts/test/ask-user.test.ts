import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { askingLine, screenQuestion } from "../src/ask-user.ts";
import { DEFAULT_RESOLVE_KINDS, isDecision } from "../src/decision-obligations.ts";
import { eventClass } from "../src/event-policy.ts";

const fixture = (name: string): string => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
// Real omo screens: a blocking question (waitForAnswer true) and the collapsed widget of an async one.
const DIALOG = fixture("omo-ask-user-dialog.txt");
const WIDGET = fixture("omo-ask-user-widget.txt");
// A real omo permission prompt: the selection list that every other prompt (select, confirm) also draws.
const PERMISSION = fixture("omo-permission-prompt.txt");
const RULE = "─".repeat(40);
const IDLE = " Done, PR open.\n─────\n❯\n─────\n~/repo • $0.000\n(😺 OmO Native by Q Kim)";

test("the blocking question dialog is read with its header, question and options", () => {
  expect(screenQuestion(DIALOG)).toEqual({ header: "Deploy", question: "QA442 which target should I deploy to?", options: ["staging", "production"], pending: 1 });
});

test("the async question widget is read with its option chips and pending count", () => {
  expect(screenQuestion(WIDGET)).toEqual({ header: "Region", question: "QA442B which region?", options: ["seoul", "tokyo"], pending: 2 });
});

test("a wrapped widget question retains its chips", () => {
  expect(screenQuestion("? Question pending (1 unanswered) · 30m\n Deploy - which target should I use for\n this environment?\n [ staging ]  [ production ]"))
    .toEqual({ header: "Deploy", question: "which target should I use for this environment?", options: ["staging", "production"], pending: 1 });
});

test("a permission prompt is read with its whole title as the question and its choices as options", () => {
  expect(screenQuestion(PERMISSION)).toEqual({ question: "Permission required: eval Tool: eval Patterns: - *", options: ["Allow once", "Allow always", "Deny", "Deny with feedback"], pending: 1 });
});

test("a subagent's confirm is read as a Yes/No selection list, its scroll rows left out", () => {
  const confirm = `${RULE}\n\n edit src/lib/shortcuts.ts overlayOpen?\n\n   … 1 more above\n → Yes\n   No\n\n ↑↓ navigate  enter select  esc cancel\n\n${RULE}\n~/repo`;
  expect(screenQuestion(confirm)).toEqual({ question: "edit src/lib/shortcuts.ts overlayOpen?", options: ["Yes", "No"], pending: 1 });
  expect(screenQuestion(`${confirm}\n${Array.from({ length: 12 }, (_, i) => ` line ${i}`).join("\n")}`)).toBeNull();
});

test("a question left in scrollback, or only quoted by the transcript, is no prompt", () => {
  expect(screenQuestion(IDLE)).toBeNull();
  expect(screenQuestion(`${DIALOG}\n${Array.from({ length: 12 }, (_, i) => ` line ${i}`).join("\n")}`)).toBeNull();
  expect(screenQuestion(` grep found: ? Question pending (1 unanswered)\n ? Question pending (1 unanswered) · 30m\n   Deploy - which target?\n${IDLE}`)).toBeNull();
});

test("the LANE_ASKING line the supervisor raises for a runner's lane.asking is urgent and a decision, with text and options", () => {
  const line = askingLine("ask-lane", screenQuestion(DIALOG) ?? { question: "", options: [], pending: 0 });
  expect(line).toBe("LANE_ASKING ask-lane waits on an on-screen question, not dori report: [Deploy] QA442 which target should I deploy to? | options: staging / production");
  expect(eventClass(line)).toBe("lead-urgent");
  expect(isDecision(line, DEFAULT_RESOLVE_KINDS)).toBe(true);
  expect(askingLine("ask-lane", screenQuestion(WIDGET) ?? { question: "", options: [], pending: 0 })).toBe("LANE_ASKING ask-lane waits on an on-screen question, not dori report: [Region] QA442B which region? | options: seoul / tokyo | 2 questions pending");
  expect(askingLine("ask-lane", screenQuestion(PERMISSION) ?? { question: "", options: [], pending: 0 })).toBe("LANE_ASKING ask-lane waits on an on-screen question, not dori report: Permission required: eval Tool: eval Patterns: - * | options: Allow once / Allow always / Deny / Deny with feedback");
});
