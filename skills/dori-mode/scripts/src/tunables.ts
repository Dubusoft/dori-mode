import { homedir } from "node:os";
import { join } from "node:path";

import { type DeliveryConfig, omoSessionsDir } from "./config.ts";
import { DEFAULT_RESOLVE_KINDS } from "./decision-obligations.ts";
import { DEFAULT_EVENT_POLICY, type EventPolicy } from "./event-policy.ts";
import type { ToodoEventsConfig } from "./toodo-events.ts";

/**
 * Built-in tunables: timings, limits, notices and policies that config.json does not set (they are not in
 * CONFIG_FILE_KEYS). Production always runs with BUILT_IN; code that reads them takes them as `deps.tunables`, so a test
 * can run the same code with other values.
 */
export type Tunables = {
  /** Start the lead with a slimmer omo context (no skills list, LEAD_DIET_EXCLUDED_TOOLS removed, chat prompt surface). Lanes are unaffected. */
  readonly leadDiet: boolean;
  readonly cacheTtlMin: number;
  readonly leadContextCapTokens: number;
  readonly leadContextHardCapTokens: number;
  readonly discordSafetyPollSeconds: number;
  /** Messages fetched (one REST page, 1-100) the first time a Discord channel is caught up with no saved cursor. */
  readonly discordFirstSeenLimit: number;
  readonly githubPollSeconds: number;
  readonly githubTimeoutMs: number;
  /** The toodo-server event stream the supervisor follows for task status changes and readiness (toodo-events.ts). */
  readonly toodoEvents: ToodoEventsConfig;
  /** Opening keywords of a `--mode ulw` lane (the default): clear, contained work. */
  readonly launchKeywords: string;
  /** Opening keywords of a `--mode mass-ulw` lane: wide changes or vague instructions that need investigation first. */
  readonly massLaunchKeywords: string;
  /** `--thinking` level for lanes; absent or blank keeps whatever `agentCommand` carries. The lead never reads it. */
  readonly laneThinking: string;
  readonly sessionsDir: string;
  readonly nudgeAfterMin: number;
  /**
   * Minutes an idle lane may stay silent after its freshness nudge before the lead hears urgent IDLE-ESCALATE; each
   * further one for the same silence waits twice as long. Must be positive.
   */
  readonly idleEscalateMin: number;
  readonly closeAfterMin: number;
  /**
   * Minutes after a claim's window starts that the claim keeps waiting for the supervisor's merge, when its only failing
   * Done signals are `merged` PRs it bound at their still-current head with no failed check and no conflict.
   */
  readonly mergeWaitMaxMin: number;
  /**
   * Minutes an open lane PR may stay unmergeable for a reason only a person fixes (claimed but no checks, review or
   * draft; green and clean but its lane never claimed at that head) before the lead hears urgent MERGE_STALLED once.
   */
  readonly mergeStallMin: number;
  /** Digest events wait for an urgent one, but never longer than this. */
  readonly digestMaxDelayMin: number;
  /** Posted once in the owner's channel or thread when the lead has not received their message within a minute. */
  readonly ownerDelayNotice: string;
  /** Seconds the lead has to ack (`dori ack`) an owner message it was handed before it is reminded (push delivery re-pushes it); twice this posts `ackMissingNotice`. */
  readonly ackTimeoutSec: number;
  /** Posted once in the owner's channel or thread when the lead got their message but has not acked it after two windows. */
  readonly ackMissingNotice: string;
  /** Minutes after reading an owner message to link all tasks with dori handled; a second window notifies the owner. */
  readonly handledTimeoutMin: number;
  readonly unhandledNotice: string;
  /** Minutes after a lane claimed done or finished (LANE_DONE_CLAIMED, LANE_CLOSED, CI_MERGED) for the lead to tell the owner and run dori reported before UNREPORTED. */
  readonly reportTimeoutMin: number;
  /** Event kinds (eventPolicy syntax) that open a decision obligation, closed by dori resolved <eventId> (decision-obligations.ts). */
  readonly resolveKinds: readonly string[];
  /** Minutes after a decision event for the lead to run dori resolved <eventId> before UNRESOLVED. */
  readonly resolveTimeoutMin: number;
  readonly deadPanePatterns: readonly string[];
  /** A wait without --timeout whose check errors or times out this many times in a row ends as WAIT_FAILED. */
  readonly waitMaxFailures: number;
  /** Per machine, no herdr call of a sweep round starts later than this many ms after the round began. */
  readonly sweepMachineDeadlineMs: number;
  /** How each event kind is delivered (event-policy.ts); a config's `kinds` are laid over the default table. */
  readonly eventPolicy: EventPolicy;
  /** Minutes a lane message may stay unconfirmed (queued or delivered without an ack) before the lead hears of it. */
  readonly ciConfirmMin: number;
  /** How events reach the lead: pushed pointers with take receipts. */
  readonly delivery: DeliveryConfig;
};

export const builtInTunables = (home = homedir()): Tunables => ({
  leadDiet: true,
  cacheTtlMin: 5,
  leadContextCapTokens: 150_000,
  leadContextHardCapTokens: 300_000,
  discordSafetyPollSeconds: 300,
  discordFirstSeenLimit: 100,
  githubPollSeconds: 90,
  githubTimeoutMs: 30_000,
  toodoEvents: { enabled: true, url: "http://127.0.0.1:47616", tokenFile: join(home, ".local", "share", "toodo-server", "web-token") },
  launchKeywords: "ulw set goal and work",
  massLaunchKeywords: "/mass-ulw set goal and work",
  laneThinking: "medium",
  sessionsDir: omoSessionsDir(home),
  nudgeAfterMin: 15,
  idleEscalateMin: 30,
  closeAfterMin: 5,
  mergeWaitMaxMin: 60,
  mergeStallMin: 15,
  digestMaxDelayMin: 60,
  ownerDelayNotice: "메시지를 받았습니다. 리드 세션이 아직 메시지를 받지 못하고 있어 대기열에 보관해 두었고, 리드가 돌아오는 대로 답변드립니다.",
  ackTimeoutSec: 60,
  ackMissingNotice: "메시지가 리드 세션에 전달됐지만 아직 읽었다는 확인이 없습니다. 리드에게 다시 알렸고, 이곳으로 답변드립니다.",
  handledTimeoutMin: 30,
  unhandledNotice: "메시지는 읽혔지만 요청하신 일 가운데 아직 작업이나 답변으로 이어지지 않은 것이 있습니다. 리드에게 처리하라고 다시 알렸습니다.",
  reportTimeoutMin: 5,
  resolveKinds: DEFAULT_RESOLVE_KINDS,
  resolveTimeoutMin: 15,
  deadPanePatterns: ["has stopped", "no suitable jobs"],
  waitMaxFailures: 30,
  sweepMachineDeadlineMs: 20_000,
  eventPolicy: DEFAULT_EVENT_POLICY,
  ciConfirmMin: 20,
  delivery: {
    tailMonitor: true, restartMaxPerHour: 3,
    push: { ackSec: 45, retries: 2, escalateMin: 5, maxChars: 200, pasteCheckMs: 3_000, toWorking: true, takeMaxBytes: 16_384 },
  },
});

export const BUILT_IN: Tunables = builtInTunables();
