import type { OwnerDecision } from "../decision-store.ts";

/**
 * Number buttons under a lane question's starter message (references/messaging.md, "Answer buttons"). The custom_id
 * `dori:decide:<dID>:<N>` names the decision and the option, so a click needs no stored state and never depends on which
 * question is newest in a shared thread.
 */

/** A decision button's custom_id: decision id, option number 1-9. */
export const DECIDE_BUTTON_ID = /^dori:decide:(d\d{1,9}):([1-9])$/;

export const decideButtonId = (decision: string, choice: number): string => `dori:decide:${decision}:${choice}`;

const ROW_MAX = 5;
const LABEL_MAX = 80;

const label = (text: string): string => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= LABEL_MAX ? chars.join("") : `${chars.slice(0, LABEL_MAX - 1).join("").trimEnd()}…`;
};

/** Whether `d` gets answer buttons: a lane's own question, never a request or a decision the lead opened. */
export const hasDecisionButtons = (d: Pick<OwnerDecision, "source" | "kind">): boolean => d.source === "lane" && d.kind !== "request";

/**
 * The action rows for `d`'s starter message, or undefined when it gets none: one button per option labelled
 * `N. <option>` (cut to 80 characters), the recommended one primary, at most 5 per row (a lane question has 2-9 options,
 * so 1 or 2 rows).
 */
export const decisionButtonRows = (d: Pick<OwnerDecision, "id" | "source" | "kind" | "options" | "recommend">): unknown[] | undefined => {
  if (!hasDecisionButtons(d)) return undefined;
  const buttons = d.options.map((option, i) => ({
    type: 2, style: i + 1 === d.recommend ? 1 : 2, label: label(`${i + 1}. ${option}`), custom_id: decideButtonId(d.id, i + 1),
  }));
  const rows: unknown[] = [];
  for (let i = 0; i < buttons.length; i += ROW_MAX) rows.push({ type: 1, components: buttons.slice(i, i + ROW_MAX) });
  return rows;
};

export type DecideInteraction = {
  readonly id: string;
  readonly token: string;
  readonly application_id: string;
  readonly guild_id: string;
  readonly userId: string;
  /** The channel the click came from: the thread id when the message is in a thread. */
  readonly channel: string;
  readonly decision: string;
  readonly choice: number;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** A decision button click, else undefined. */
export const decideInteraction = (value: unknown): DecideInteraction | undefined => {
  if (!record(value) || value.type !== 3 || !record(value.data) || value.data.component_type !== 2 || typeof value.data.custom_id !== "string") return;
  const match = DECIDE_BUTTON_ID.exec(value.data.custom_id);
  if (!match) return;
  if (typeof value.id !== "string" || typeof value.token !== "string" || typeof value.application_id !== "string" || typeof value.guild_id !== "string") return;
  if (typeof value.channel_id !== "string" || !record(value.member) || !record(value.member.user) || typeof value.member.user.id !== "string") return;
  return {
    id: value.id, token: value.token, application_id: value.application_id, guild_id: value.guild_id, userId: value.member.user.id,
    channel: value.channel_id, decision: match[1]!, choice: Number(match[2]),
  };
};
