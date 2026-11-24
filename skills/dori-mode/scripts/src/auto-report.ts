import { publishedDecisions } from "./decision-obligations.ts";
import { scrubForThread } from "./freshness.ts";
import { oneLine } from "./line-text.ts";
import { openOwnerDecisions } from "./owner-decisions.ts";
import type { Claim, Lane } from "./registry.ts";
import { postLaneReport, type ReportPostDeps } from "./report-post.ts";
import { factLanguage } from "./task-finish.ts";

/**
 * The supervisor's own report of a clean done claim (config `autoReport`, done-flow.ts watchLane): instead of waking the
 * lead with LANE_DONE_CLAIMED, it posts the lane's done text, under a fixed header, as the lane's report in its thread
 * (report-post.ts, the path `dori reported` takes) and hands the lead a digest LANE_DONE_AUTO_REPORTED. The merge fact
 * the supervisor appends at the close lands on that message. A claim is clean only when its done text is written in the
 * owner's language (writtenIn) and nothing is open on the lane for the lead (openAsks); done-flow.ts adds the rest.
 */

/**
 * The `autoReported` mark (and `report=` in LANE_DONE_AUTO_REPORTED) of a claim of a lane config `reportQuietLanes`
 * names: recorded reported with nothing posted, because the lane posts its own results (done-flow.ts).
 */
export const QUIET_REPORT = "quiet";

/** Posts lane `lane`'s auto report of `claim` and records it reported; returns the message id. Throws when nothing was posted. */
export type AutoReportPost = (lane: Lane, claim: Claim) => Promise<string>;

/**
 * What is open on lane `lane` for the lead, as the supervisor last published it: a blocking owner decision (question or
 * request) not closed yet, and an unresolved decision event naming the lane (its question or blocker, an earlier
 * LANE_NOT_DONE, an answered decision). Each one is a reason the claim goes to the lead.
 */
export const openAsks = (stateDir: string, lane: string): string[] => [
  ...openOwnerDecisions(stateDir).filter((d) => d.lane === lane && d.blocking).map((d) => `blocking owner decision ${d.id} is ${d.state}`),
  ...publishedDecisions(stateDir).filter((item) => item.line?.split(" ")[1] === lane).map((item) => `unresolved event ${item.id}`),
];

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** The least share of a text's letters in the owner's script: Korean, Japanese and Chinese text mixes in Latin names. */
const OWN_SCRIPT_MIN = 0.3;
/** English text may carry a few foreign letters (a name), not more. */
const LATIN_MIN = 0.9;

/**
 * Whether `text` reads as written in `language` (config ownerLanguage, as task-finish.ts factLanguage reads it): the
 * share of its letters in that language's script, ignoring links and code spans. Unset or any other language is English.
 */
export const writtenIn = (text: string, language: string | undefined): boolean => {
  const letters = [...text.replace(/https?:\/\/\S+/g, " ").replace(/`[^`]*`/g, " ")].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return false;
  const share = (script: RegExp): number => letters.filter((c) => script.test(c)).length / letters.length;
  switch (factLanguage(language)) {
    case "ko": return share(/\p{Script=Hangul}/u) >= OWN_SCRIPT_MIN;
    case "ja": return share(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u) >= OWN_SCRIPT_MIN && letters.some((c) => KANA.test(c));
    case "zh": return share(/\p{Script=Han}/u) >= OWN_SCRIPT_MIN && !letters.some((c) => KANA.test(c));
    case "en": return share(/\p{Script=Latin}/u) >= LATIN_MIN;
  }
};

/** Per owner language: the space before the key's parenthesis, the `[System]` header naming the finished lane, and the evidence label. */
const WORDS = {
  ko: { keySpace: "", header: (name: string) => `${name} 완료했습니다.`, evidence: "근거" },
  ja: { keySpace: "", header: (name: string) => `${name}が完了しました。`, evidence: "根拠" },
  zh: { keySpace: "", header: (name: string) => `${name}已完成。`, evidence: "依据" },
  en: { keySpace: " ", header: (name: string) => `${name} is done.`, evidence: "Evidence" },
} as const;

/** Longest auto report: room is left in Discord's 2000-character message for the merge fact appended at the close. */
export const AUTO_REPORT_MAX = 1500;

/**
 * The auto report of `claim`: a `[System]` header like the supervisor's other posts (`[System] <title>(<key>) 완료했습니다.`,
 * the key alone when the lane has no title of its own), the lane's done text as written, then its evidence when it says
 * more than the text, in the owner's language; secrets, local paths and pane ids are scrubbed as for any thread post.
 */
export const autoReportText = (lane: Pick<Lane, "key" | "title">, claim: Pick<Claim, "text" | "evidence">, language: string | undefined, home: string): string => {
  const words = WORDS[factLanguage(language)];
  const name = lane.title && lane.title !== lane.key ? `${lane.title}${words.keySpace}(${lane.key})` : lane.key;
  const body = scrubForThread(claim.text ?? "", home);
  const evidence = scrubForThread(claim.evidence, home);
  const text = [`[System] ${words.header(name)}`, body, ...(evidence && evidence !== oneLine(body) ? [`${words.evidence}: ${evidence}`] : [])].join("\n");
  return text.length <= AUTO_REPORT_MAX ? text : `${text.slice(0, AUTO_REPORT_MAX - 3)}...`;
};

/** The supervisor's AutoReportPost: autoReportText through postLaneReport, in the owner's language read at each post. */
export const autoReportPoster = (deps: ReportPostDeps & { readonly home: string; readonly language: () => string | undefined }): AutoReportPost =>
  async (lane, claim) => (await postLaneReport(deps, lane, autoReportText(lane, claim, deps.language(), deps.home), { note: "auto-reported by the supervisor" })).message;
