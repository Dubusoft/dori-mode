import { fillHook } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { discordStatusTransport, type LaneStatusTransport } from "./lane-reports.ts";
import { redirectHookPost } from "./thread-followup.ts";

/** Marks every sandbox notice so the owner reads it as a warning about the lane's isolation, not as lane output. */
export const SANDBOX_NOTICE_PREFIX = "[sandbox] ";

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 160);

/**
 * Posts a sandbox refusal or an allowed unsandboxed run to the owner on Discord and returns the event lines to log.
 * Into the lane's thread through hooks.threadReply (as finishRecovery posts LANE_RECOVERED) when the lane has one; else,
 * or when that post fails, to the owner's main channel (discordChannels[0]) through the Discord status transport on
 * DORI_DISCORD_TOKEN (lane-reports.ts discordStatusTransport). Without either the notice cannot reach Discord, so, like a
 * lane report that has no thread, it falls back to the lead's journal: the returned SANDBOX_NOTICE_ERROR line carries the
 * text. A lane thread the owner closed is not posted into: one line linking it goes to its parent channel (else the
 * owner channel) through the transport instead (redirectHookPost); when that fails the notice goes to the owner channel
 * as above. Never throws. `transport` is for tests; absent it is discordStatusTransport.
 */
export const postSandboxNotice = async (
  deps: FlowDeps, lane: { readonly key: string; readonly thread?: string }, text: string,
  transport: LaneStatusTransport | undefined = discordStatusTransport(deps.clock),
): Promise<string[]> => {
  const body = text.startsWith(SANDBOX_NOTICE_PREFIX) ? text : `${SANDBOX_NOTICE_PREFIX}${text}`;
  const failures: string[] = [];
  const hook = deps.config.hooks.threadReply;
  let closed = false;
  if (lane.thread && lane.thread !== "none") {
    try {
      if (await redirectHookPost(deps.config.stateDir, transport, lane.thread, body, deps.config.discordChannels[0], `sandbox-notice:${lane.key}:${deps.clock.now()}`)) return [];
    } catch (error) {
      closed = true;
      failures.push(`closed thread redirect failed: ${oneLine(error instanceof Error ? error.message : String(error))}`);
    }
  }
  if (hook && !closed && lane.thread && lane.thread !== "none") {
    try {
      const posted = await deps.run(fillHook(hook, { thread: lane.thread, key: lane.key, text: body }));
      if (posted.code === 0) return [];
      failures.push(`thread post failed: ${oneLine(posted.err || posted.out || `exit ${posted.code}`)}`);
    } catch (error) { failures.push(`thread post failed: ${oneLine(error instanceof Error ? error.message : String(error))}`); }
  }
  const main = deps.config.discordChannels[0];
  if (!transport || !main) failures.push(!transport ? "no DORI_DISCORD_TOKEN for the owner channel" : "no discordChannels configured");
  else {
    try {
      await transport.post(main, body, `sandbox-notice:${lane.key}:${deps.clock.now()}`);
      return failures.length ? [`SANDBOX_NOTICE_FALLBACK ${lane.key} posted to the owner channel (${failures.join("; ")})`] : [];
    } catch (error) { failures.push(`owner channel post failed: ${oneLine(error instanceof Error ? error.message : String(error))}`); }
  }
  return [`SANDBOX_NOTICE_ERROR ${lane.key} (${failures.join("; ")}): ${body}`];
};

/** Posts each SANDBOX_SKIPPED note of a launch (an allowed unsandboxed run) as a sandbox notice; returns the notices' event lines. */
export const postSkippedNotices = async (deps: FlowDeps, lane: { readonly key: string; readonly thread?: string }, notes: readonly string[]): Promise<string[]> => {
  const lines: string[] = [];
  for (const note of notes) if (note.startsWith("SANDBOX_SKIPPED")) lines.push(...await postSandboxNotice(deps, lane, note));
  return lines;
};
