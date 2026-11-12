/**
 * The fixed text form of a lane question that asks the owner to choose (owner decision channel). The lane CLI checks
 * the choices and writes them into the report's `text` in this form, so the runner protocol (`lane.report`) is unchanged
 * and an older hub or runner carries it like any question. The supervisor reads it back with parseDecisionText; a
 * question whose text is not in this form (an older runner's free-text question) is routed as before.
 *
 * ```
 * DECISION v1
 * Q: <question>
 * 1) <option>
 * 2) <option>
 * REC 1: <reason>
 * WAIT: <what is paused, or what goes ahead on the recommendation>
 * MODE: blocking|nonblocking
 * ```
 */

export const DECISION_TEXT_HEAD = "DECISION v1";
export const DECISION_OPTIONS_MIN = 2;
export const DECISION_OPTIONS_MAX = 9;
export const DECISION_QUESTION_MAX = 300;
export const DECISION_OPTION_MAX = 200;
export const DECISION_REASON_MAX = 300;
export const DECISION_WAITING_MAX = 300;

export type DecisionChoices = {
  readonly question: string;
  readonly options: readonly string[];
  /** 1-based index into `options`. */
  readonly recommend: number;
  readonly reason: string;
  readonly waiting: string;
  /** false: the asker goes ahead on the recommendation while it waits. */
  readonly blocking: boolean;
};

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Why `choices` cannot become a decision (one line), or undefined when it can: 2-9 options, a recommendation in range, and
 * a question, reason and waiting text, each within its length. Texts are read as one line (whitespace collapsed).
 */
export const decisionChoicesProblem = (choices: {
  readonly question?: string; readonly options?: readonly string[]; readonly recommend?: number | string;
  readonly reason?: string; readonly waiting?: string;
}): string | undefined => {
  const options = (choices.options ?? []).map(flat);
  if (options.length < DECISION_OPTIONS_MIN || options.length > DECISION_OPTIONS_MAX) return `needs ${DECISION_OPTIONS_MIN}-${DECISION_OPTIONS_MAX} --option values, got ${options.length}`;
  const empty = options.findIndex((o) => !o);
  if (empty >= 0) return `option ${empty + 1} is empty`;
  const long = options.findIndex((o) => o.length > DECISION_OPTION_MAX);
  if (long >= 0) return `option ${long + 1} is longer than ${DECISION_OPTION_MAX} characters`;
  const recommend = typeof choices.recommend === "string" ? (/^\d+$/.test(choices.recommend.trim()) ? Number(choices.recommend.trim()) : NaN) : choices.recommend;
  if (recommend === undefined) return "needs --recommend N";
  if (!Number.isInteger(recommend) || recommend < 1 || recommend > options.length) return `--recommend must be 1-${options.length}`;
  const text = (name: string, value: string | undefined, max: number): string | undefined => {
    const v = flat(value ?? "");
    if (!v) return `needs ${name}`;
    return v.length > max ? `${name} is longer than ${max} characters` : undefined;
  };
  return text("a question", choices.question, DECISION_QUESTION_MAX) ?? text("--reason", choices.reason, DECISION_REASON_MAX)
    ?? text("--waiting", choices.waiting, DECISION_WAITING_MAX);
};

/** `choices` (already checked with decisionChoicesProblem) in the fixed text form. */
export const serializeDecisionText = (choices: DecisionChoices): string => [
  DECISION_TEXT_HEAD,
  `Q: ${flat(choices.question)}`,
  ...choices.options.map((option, i) => `${i + 1}) ${flat(option)}`),
  `REC ${choices.recommend}: ${flat(choices.reason)}`,
  `WAIT: ${flat(choices.waiting)}`,
  `MODE: ${choices.blocking ? "blocking" : "nonblocking"}`,
].join("\n");

/**
 * The choices in `text` when it is in the fixed text form and passes decisionChoicesProblem, else undefined (a free-text
 * question). Leading and trailing blank lines are ignored; any other line out of place makes it free text.
 */
export const parseDecisionText = (text: string): DecisionChoices | undefined => {
  const lines = text.trim().split("\n").map((line) => line.trimEnd());
  if (lines[0]?.trim() !== DECISION_TEXT_HEAD) return undefined;
  const question = /^Q: (.+)$/.exec(lines[1] ?? "")?.[1];
  const options: string[] = [];
  let i = 2;
  for (; i < lines.length; i++) {
    const m = /^(\d+)\) (.+)$/.exec(lines[i] ?? "");
    if (!m || Number(m[1]) !== options.length + 1) break;
    options.push(m[2] as string);
  }
  const rec = /^REC (\d+): (.+)$/.exec(lines[i] ?? "");
  const wait = /^WAIT: (.+)$/.exec(lines[i + 1] ?? "")?.[1];
  const mode = /^MODE: (blocking|nonblocking)$/.exec(lines[i + 2] ?? "")?.[1];
  if (!question || !rec || !wait || !mode || lines.length !== i + 3) return undefined;
  const choices: DecisionChoices = { question, options, recommend: Number(rec[1]), reason: rec[2] as string, waiting: wait, blocking: mode === "blocking" };
  return decisionChoicesProblem(choices) === undefined ? choices : undefined;
};
