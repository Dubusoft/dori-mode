import { recoverCommand } from "./recover.ts";
import { leadRestartCommand } from "./lead-restart.ts";
import { updateCommand } from "./update.ts";
import { reposCommand } from "./repos.ts";
import { secretCommand } from "./secret.ts";
import { waitCommand } from "./wait.ts";
import { emitCommand } from "./emit.ts";
import { sourceCommand } from "./source.ts";
import { scheduleCommand } from "./schedule.ts";
import { superviseCommand } from "./supervise.ts";
import { quotaCommand } from "./quota.ts";
import { launchCommand } from "./launch.ts";
import { autopilotCommand } from "./autopilot.ts";
import { mergeCommand } from "./merge.ts";
import { reviewCommand } from "./review.ts";
import { holdCommand } from "./hold.ts";
import { adoptCommand } from "./adopt.ts";
import { syncCommand } from "./sync.ts";
import { attachCommand } from "./attach.ts";
import { claimDoneCommand } from "./claim-done.ts";
import { laneCommand } from "./lane.ts";
import { objectDoneCommand } from "./object-done.ts";
import { opsCommand } from "./ops.ts";
import { closeCommand } from "./close.ts";
import { pauseCommand } from "./pause.ts";
import { watchCommand } from "./watch.ts";
import { freshnessCommand } from "./freshness.ts";
import { deadPanesCommand } from "./dead-panes.ts";
import { guardCommand } from "./guard.ts";
import { heavyCommand } from "./heavy.ts";
import { canLaunchCommand } from "./can-launch.ts";
import { placementCommand } from "./placement.ts";
import { memoryCommand } from "./memory.ts";
import { eventCommand } from "./event.ts";
import { inboxCommand } from "./inbox.ts";
import { reportCommand } from "./report.ts";
import { resolvedCommand } from "./resolved.ts";
import { decisionCommand } from "./decision.ts";
import { discordCommand } from "./discord.ts";
import { presenceCommand } from "./presence.ts";
import { transcribeCommand } from "./transcribe.ts";
import type { ParseArgsOptionsConfig } from "node:util";

import type { CliCommand } from "./context.ts";

/** The lead's commands by name, each in its own module (setup, doctor, status and runner are routed before config loads). */
export const COMMANDS: Readonly<Record<string, CliCommand>> = {
  recover: recoverCommand,
  "lead-restart": leadRestartCommand,
  update: updateCommand,
  repos: reposCommand,
  secret: secretCommand,
  wait: waitCommand,
  emit: emitCommand,
  source: sourceCommand,
  schedule: scheduleCommand,
  supervise: superviseCommand,
  quota: quotaCommand,
  launch: launchCommand,
  autopilot: autopilotCommand,
  merge: mergeCommand,
  review: reviewCommand,
  hold: holdCommand,
  adopt: adoptCommand,
  sync: syncCommand,
  attach: attachCommand,
  "claim-done": claimDoneCommand,
  lane: laneCommand,
  "object-done": objectDoneCommand,
  ops: opsCommand,
  close: closeCommand,
  pause: pauseCommand,
  resume: pauseCommand,
  watch: watchCommand,
  freshness: freshnessCommand,
  "dead-panes": deadPanesCommand,
  guard: guardCommand,
  heavy: heavyCommand,
  "can-launch": canLaunchCommand,
  placement: placementCommand,
  memory: memoryCommand,
  event: eventCommand,
  inbox: inboxCommand,
  report: reportCommand,
  resolved: resolvedCommand,
  decision: decisionCommand,
  ack: discordCommand,
  reported: discordCommand,
  handled: discordCommand,
  send: discordCommand,
  thread: discordCommand,
  typing: discordCommand,
  presence: presenceCommand,
  transcribe: transcribeCommand,
};

/** Every flag some command declares: the arguments are parsed with these whichever command runs. */
export const KNOWN_OPTIONS: ParseArgsOptionsConfig = Object.assign({}, ...Object.values(COMMANDS).map((c) => c.options));
