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

/**
 * The fixed text form of a lane request for owner input (a one-time code, a file or value only the owner can give), carried
 * over a `question` report like DECISION v1. `SEND: thread` asks for a reply in the request thread; `SEND: file <path>`
 * asks the owner to put it in that file (chmod 600) and only say so in the thread.
 *
 * ```
 * REQUEST v1
 * NEED: <what is needed>
 * WHY: <why>
 * SEND: thread|file <path>
 * WAIT: <what is paused, or what goes ahead meanwhile>
 * MODE: blocking|nonblocking
 * ```
 */
export const REQUEST_TEXT_HEAD = "REQUEST v1";
export const REQUEST_FILE_MAX = 300;

export type InputRequest = {
  readonly need: string;
  readonly reason: string;
  /** Where the owner puts the value instead of replying in the thread; undefined: reply in the thread. */
  readonly file?: string;
  readonly waiting: string;
  readonly blocking: boolean;
};

/**
 * Long-lived secrets: never asked for in Discord, only through a file. A request that names one without a file is refused;
 * short one-time codes (2FA, login or device codes) may come back in the thread.
 */
export const LONG_LIVED_SECRET = /pass(?:word|phrase|wd)|api[\s_-]?key|secret|token|private[\s_-]?key|credential|비밀번호|패스워드|암호|토큰|시크릿|API\s?키|개인\s?키/i;

/** A file path the owner can write to: absolute (`/...`, `C:\...`) or under the home directory (`~/...`). */
const isOwnerPath = (path: string): boolean => /^(?:\/|~\/|[A-Za-z]:[\\/])\S/.test(path);

/**
 * Why `request` cannot be sent (one line), or undefined when it can: a need, reason and waiting text within their lengths,
 * an absolute or `~/` file path when one is given, and a file path whenever the need or reason names a long-lived secret.
 */
export const inputRequestProblem = (request: {
  readonly need?: string; readonly reason?: string; readonly file?: string; readonly waiting?: string;
}): string | undefined => {
  const text = (name: string, value: string | undefined, max: number): string | undefined => {
    const v = flat(value ?? "");
    if (!v) return `needs ${name}`;
    return v.length > max ? `${name} is longer than ${max} characters` : undefined;
  };
  const problem = text("what is needed (--text)", request.need, DECISION_QUESTION_MAX) ?? text("--reason", request.reason, DECISION_REASON_MAX)
    ?? text("--waiting", request.waiting, DECISION_WAITING_MAX);
  if (problem) return problem;
  const file = request.file === undefined ? undefined : flat(request.file);
  if (file !== undefined) {
    if (!isOwnerPath(file)) return `--file must be an absolute or ~/ path, got "${file}"`;
    if (file.length > REQUEST_FILE_MAX) return `--file is longer than ${REQUEST_FILE_MAX} characters`;
    return undefined;
  }
  return LONG_LIVED_SECRET.test(`${request.need} ${request.reason}`)
    ? "a long-lived secret (password, API key, token) is never asked for in Discord: name the file the owner writes it to with --file <path> (chmod 600)"
    : undefined;
};

/** `request` (already checked with inputRequestProblem) in the fixed text form. */
export const serializeRequestText = (request: InputRequest): string => [
  REQUEST_TEXT_HEAD,
  `NEED: ${flat(request.need)}`,
  `WHY: ${flat(request.reason)}`,
  `SEND: ${request.file === undefined ? "thread" : `file ${flat(request.file)}`}`,
  `WAIT: ${flat(request.waiting)}`,
  `MODE: ${request.blocking ? "blocking" : "nonblocking"}`,
].join("\n");

/** The request in `text` when it is in the fixed text form and passes inputRequestProblem, else undefined. */
export const parseRequestText = (text: string): InputRequest | undefined => {
  const lines = text.trim().split("\n").map((line) => line.trimEnd());
  if (lines.length !== 6 || lines[0]?.trim() !== REQUEST_TEXT_HEAD) return undefined;
  const need = /^NEED: (.+)$/.exec(lines[1] ?? "")?.[1];
  const reason = /^WHY: (.+)$/.exec(lines[2] ?? "")?.[1];
  const send = /^SEND: (thread|file (.+))$/.exec(lines[3] ?? "");
  const waiting = /^WAIT: (.+)$/.exec(lines[4] ?? "")?.[1];
  const mode = /^MODE: (blocking|nonblocking)$/.exec(lines[5] ?? "")?.[1];
  if (!need || !reason || !send || !waiting || !mode) return undefined;
  const request: InputRequest = { need, reason, ...(send[2] ? { file: send[2] } : {}), waiting, blocking: mode === "blocking" };
  return inputRequestProblem(request) === undefined ? request : undefined;
};
