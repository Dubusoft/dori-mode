import type { OwnerDecision } from "../decision-store.ts";

/**
 * Number buttons under a question's starter message (references/messaging.md, "Answer buttons"). The custom_id
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

/** Whether `d` gets answer buttons: a question with options, a lane's or the lead's; never a request. */
export const hasDecisionButtons = (d: Pick<OwnerDecision, "kind" | "options">): boolean => d.kind !== "request" && d.options.length > 0;

type ButtonState = Pick<OwnerDecision, "id" | "kind" | "options" | "recommend"> & Partial<Pick<OwnerDecision, "state" | "choice" | "revisions" | "answers">>;

/** The option the owner's newest button press for the lead holds (an OwnerAnswer with a choice), with when it was made. */
export const leadClick = (d: Pick<OwnerDecision, "answers">): { readonly choice: number; readonly at: number } | undefined => {
  const click = d.answers?.filter((a) => a.choice !== undefined).at(-1);
  return click?.choice === undefined ? undefined : { choice: click.choice, at: click.at };
};

/**
 * What `d`'s buttons show: the selected option (a closed decision's choice, else the newer of the newest answer revision's
 * choice, none after a withdrawal, and the newest button press handed to the lead) and whether they are all disabled
 * (closed, or the newest answer revision was acked or found undelivered). A withdrawal the lane acked reopens the
 * question, so its buttons stay live.
 */
export const decisionButtonState = (d: ButtonState): { readonly selected?: number; readonly disabled: boolean } => {
  const newest = d.revisions?.at(-1);
  const click = leadClick(d);
  const selected = d.state === "closed" ? d.choice : click && (!newest || click.at >= newest.at) ? click.choice : newest?.choice;
  const disabled = d.state === "closed" || newest?.delivery.state === "undelivered" || (newest?.delivery.state === "acked" && newest.choice !== undefined);
  return { ...(selected !== undefined ? { selected } : {}), disabled };
};

/** A compact key of decisionButtonState, kept on the decision as what its starter message last showed. */
export const decisionButtonsKey = (d: ButtonState): string => {
  const s = decisionButtonState(d);
  return `${s.selected ?? "-"}:${s.disabled ? "off" : "on"}`;
};

/** The key of the buttons as first posted: nothing selected, all live. */
export const POSTED_BUTTONS_KEY = "-:on";

/**
 * The action rows for `d`'s starter message, or undefined when it gets none: one button per option labelled
 * `N. <option>` (cut to 80 characters), the recommended one primary, at most 5 per row (a lane question has 2-9 options,
 * so 1 or 2 rows). The selected option (decisionButtonState) is green and marked `✓`; disabled rows are all disabled.
 */
export const decisionButtonRows = (d: ButtonState): unknown[] | undefined => {
  if (!hasDecisionButtons(d)) return undefined;
  const { selected, disabled } = decisionButtonState(d);
  const buttons = d.options.map((option, i) => ({
    type: 2, style: i + 1 === selected ? 3 : i + 1 === d.recommend ? 1 : 2, label: label(`${i + 1 === selected ? "✓ " : ""}${i + 1}. ${option}`),
    custom_id: decideButtonId(d.id, i + 1), ...(disabled ? { disabled: true } : {}),
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
  /** The message carrying the buttons, when Discord sent it: a late click updates them through it. */
  readonly message?: string;
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
  const message = record(value.message) && typeof value.message.id === "string" ? value.message.id : undefined;
  return {
    id: value.id, token: value.token, application_id: value.application_id, guild_id: value.guild_id, userId: value.member.user.id,
    channel: value.channel_id, decision: match[1]!, choice: Number(match[2]), ...(message ? { message } : {}),
  };
};
