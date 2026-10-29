import { createHash } from "node:crypto";

import { type Emit, type FlowDeps, laneMeta } from "./done-flow.ts";
import { redactSecrets } from "./redact.ts";
import { statusOf } from "./registry.ts";
import { passthroughView, type SweepView } from "./sweep-view.ts";

/**
 * A lane should ask with `dori report <key> question`, which wakes the lead. A lane that asks only through its agent's
 * on-screen question UI (omo's ask-user) wakes nobody and sits there until someone looks at its pane. This sweep reads
 * each open lane's pane for such a prompt and raises one urgent `LANE_ASKING` per question, with its text and options;
 * once the prompt is gone (answered, cancelled, timed out) the next prompt is raised again.
 */

/** A question prompt on screen: the current question's header, text and options, and how many questions it holds. */
export type ScreenQuestion = { readonly header?: string; readonly question: string; readonly options: readonly string[]; readonly pending: number; readonly tabs?: readonly string[] };

/** How many bottom lines of a pane are read: the prompt is part of the live UI at the bottom, never scrollback. */
export const ASK_SCREEN_LINES = 60;
/** At most this many non-empty lines (hints, editor, rules, status bar) may follow a prompt's last line. */
const BELOW_MAX = 10;

const OPTION = /^\s*(?:→\s*)?(?:\[[ x✓✔]\]\s*)?\d+\.\s+(.+?)\s*$/;
const OWN_ANSWER = /^\s*(?:→\s*)?Type your own answer/;
/** The blocking dialog's key-hint line, its last line ("↑↓ move  1-9 select ... esc cancel"). */
const DIALOG_HINT = /\b1-9 select\b.*\besc cancel\b/;
const DIALOG_HEAD = /^\s*Ask user\b/;
/**
 * The collapsed widget an async question (waitForAnswer false) leaves above the editor. It starts at column 0, where the
 * transcript is indented, so a line of output that only quotes it never matches.
 */
const WIDGET_HEAD = /^\? (?:Question pending \((\d+) unanswered\)|(\d+) questions pending)/;
/** The widget's option chips: "[ seoul ]  [ tokyo ]  [ own answer… ]". */
const CHIP = /\[ (.+?) \]/g;
const CHIP_LINE = /\[ .+? \]/;

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
const nonEmptyAfter = (lines: readonly string[], i: number): number => lines.slice(i + 1).filter((l) => l.trim()).length;

/** Options listed from `from` on, up to the own-answer row (or the first line that is no option once some were seen). */
const optionsFrom = (lines: readonly string[], from: number, to: number): string[] => {
  const options: string[] = [];
  for (let i = from; i < to; i++) {
    const line = lines[i] ?? "";
    if (OWN_ANSWER.test(line)) break;
    const hit = OPTION.exec(line);
    if (hit?.[1]) options.push(clean(hit[1]));
    else if (options.length && line.trim()) break;
  }
  return options;
};

/** The blocking question dialog (waitForAnswer true): "Ask user", a tab row "→ <header>  ...  Submit", the question, its options. */
const dialog = (lines: readonly string[]): ScreenQuestion | null => {
  const hint = lines.findLastIndex((l) => DIALOG_HINT.test(l));
  if (hint < 0 || nonEmptyAfter(lines, hint) > BELOW_MAX) return null;
  const head = lines.slice(0, hint).findLastIndex((l) => DIALOG_HEAD.test(l));
  if (head < 0) return null;
  const tabs = lines.findIndex((l, i) => i > head && i < hint && /^\s*\S.*\bSubmit\s*$/.test(l));
  const firstOption = lines.findIndex((l, i) => i > Math.max(head, tabs) && i < hint && (OPTION.test(l) || OWN_ANSWER.test(l)));
  if (tabs < 0 || firstOption < 0) return null;
  const tabNames = lines[tabs]?.replace(/\bSubmit\s*$/, "").split(/\s{2,}/).map(clean).filter(Boolean) ?? [];
  const header = tabNames.find((t) => t.startsWith("→"))?.replace(/^→\s*/, "");
  const question = clean(lines.slice(tabs + 1, firstOption).join(" "));
  if (!question) return null;
  return { ...(header ? { header } : {}), question, options: optionsFrom(lines, firstOption, hint), pending: Math.max(tabNames.length, 1), ...(tabNames.length > 1 ? { tabs: tabNames.map((t) => t.replace(/^→\s*/, "")) } : {}) };
};

/** The collapsed widget: "? Question pending (N unanswered) · 30m", "  <header> - <question>", then its option chips. */
const widget = (lines: readonly string[]): ScreenQuestion | null => {
  const head = lines.findLastIndex((l) => WIDGET_HEAD.test(l));
  if (head < 0 || nonEmptyAfter(lines, head) > BELOW_MAX + 3) return null;
  const counted = WIDGET_HEAD.exec(lines[head] ?? "");
  const pending = Number(counted?.[1] ?? counted?.[2] ?? 1);
  const at = lines.findIndex((l, i) => i > head && l.trim() !== "");
  if (at < 0) return null;
  let chipAt = -1;
  const questionLines: string[] = [];
  for (let i = at; i < lines.length && questionLines.length < 4; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || CHIP_LINE.test(line) || OPTION.test(line) || OWN_ANSWER.test(line)) { chipAt = i; break; }
    questionLines.push(clean(line));
  }
  const first = questionLines[0] ?? "";
  if (!first) return null;
  const chipLine = chipAt < 0 ? -1 : lines.slice(chipAt, chipAt + 3).findIndex((line) => CHIP_LINE.test(line));
  const chips = chipLine < 0 ? [] : [...(lines[chipAt + chipLine] ?? "").matchAll(CHIP)].map((m) => clean(m[1] ?? "")).filter((c) => !/^own answer/.test(c));
  const options = chips.length ? chips : optionsFrom(lines, chipAt >= 0 ? chipAt : at + questionLines.length, lines.length);
  const split = /^(.+?) - (.+)$/.exec(first);
  const question = [split?.[2] ?? first, ...questionLines.slice(1)].join(" ");
  return { ...(split?.[1] ? { header: split[1] } : {}), question: clean(question), options, pending };
};

/** The question prompt waiting at the bottom of `screen`, or null when there is none. */
export const screenQuestion = (screen: string): ScreenQuestion | null => {
  const lines = screen.split("\n").slice(-ASK_SCREEN_LINES).map((l) => l.trimEnd());
  return dialog(lines) ?? widget(lines);
};

/** The urgent event line for `key`'s on-screen question, one line, secrets redacted. */
export const askingLine = (key: string, q: ScreenQuestion): string => {
  const options = q.options.length ? ` | options: ${q.options.join(" / ")}` : "";
  const more = q.pending > 1 ? ` | ${q.pending} questions pending` : "";
  const body = redactSecrets(clean(`${q.header ? `[${q.header}] ` : ""}${q.question}${options}${more}`)).slice(0, 400);
  return `LANE_ASKING ${key} waits on an on-screen question, not dori report: ${body}`;
};

/**
 * What identifies one question across ticks: the same prompt still showing is never raised twice, also when the lane's
 * owner opens the collapsed widget into the dialog (their pending counts differ, so the count is left out).
 */
const questionKey = (q: ScreenQuestion): string =>
  createHash("sha256").update(JSON.stringify(q.tabs && q.tabs.length > 1 ? [q.tabs] : [q.header ?? "", q.question, q.options])).digest("hex").slice(0, 16);

/**
 * One pass over the open lanes (a paused lane is skipped: it is stopped on purpose). A prompt not raised yet is emitted
 * as urgent LANE_ASKING and remembered on the lane (`lastAskPrompt`); a lane whose prompt is gone forgets it, so its next
 * question is raised again. Empty screen reads leave the remembered prompt unchanged. The line is emitted before the lane
 * records it, so a crash in between repeats it, never drops it.
 */
export const askUserTick = async (deps: FlowDeps, emit: Emit, view: SweepView = passthroughView(deps.run)): Promise<void> => {
  let firstError: unknown;
  for (const lane of await deps.registry.open()) {
    try {
      if (!lane.pane || lane.recoveryPending || statusOf(lane) === "paused") continue;
      const screen = await view.screen(lane, ASK_SCREEN_LINES);
      if (!screen.trim()) continue;
      const asked = screenQuestion(screen);
      const seen = asked ? questionKey(asked) : undefined;
      if (seen === lane.lastAskPrompt) continue;
      if (asked) await emit(askingLine(lane.key, asked), undefined, laneMeta(lane));
      await deps.registry.patch(lane.key, { lastAskPrompt: seen });
    } catch (error) { firstError ??= error; }
  }
  if (firstError !== undefined) throw firstError;
};
