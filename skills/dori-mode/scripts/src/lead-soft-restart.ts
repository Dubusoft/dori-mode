import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "./done-flow.ts";
import { ALIVE_STATUSES, paneRow, readScreen, sendGuarded } from "./panes.ts";
import { sessionRuntime } from "./runtime/index.ts";
import { sessionDirFor } from "./session-id.ts";
import { plainShell, processInfo, STARTUP_ERROR, STARTUP_EVIDENCE_MS } from "./lead-process.ts";
import { TransientSuperviseError } from "./supervise-journal.ts";

export const softLive = async (deps: FlowDeps): Promise<boolean> => {
  const pane = await paneRow(deps.run, deps.config.leadPane);
  return !!pane?.agent && ALIVE_STATUSES.has(pane.agent_status ?? "");
};

/**
 * Submit, then observe a completed interactive command before submitting the next one. Typing alone changes the screen,
 * and omo's argument autocomplete takes the first Enter to accept its selection, leaving the command in the editor;
 * a command still shown there gets Enter again, so the next command is never typed onto the same line.
 */
export const softCommand = async (deps: FlowDeps, command: string, prompt = false): Promise<void> => {
  const pane = await paneRow(deps.run, deps.config.leadPane);
  if (!pane?.agent || (pane.agent_status !== "idle" && pane.agent_status !== "done")) throw new TransientSuperviseError("lead left idle/done before soft command");
  const before = await readScreen(deps.run, deps.config.leadPane);
  const previous = new Set(before.split("\n"));
  if (await sendGuarded(deps.run, deps.config.leadPane, command) === "failed") throw new TransientSuperviseError("soft command send failed");
  if (prompt) return;
  const deadline = deps.clock.now() + 5_000;
  let enters = 1;
  for (let attempt = 0; attempt <= 25; attempt++) {
    const after = await paneRow(deps.run, deps.config.leadPane);
    const screen = await readScreen(deps.run, deps.config.leadPane);
    const addedLines = screen.split("\n").filter((line) => !previous.has(line));
    // omo's terminal integration can release the pane's agent once /new has shut the old session down; that is /new
    // taking effect, and softSessionStarted waits for the agent to come back.
    if (command === "/new" && !after?.agent) return;
    if (!after?.agent || (after.agent_status !== "idle" && after.agent_status !== "done") || STARTUP_ERROR.test(addedLines.join("\n"))) throw new TransientSuperviseError("lead not ready after soft command");
    if (addedLines.some((line) => line.includes(command))) {
      if (enters >= 3) throw new TransientSuperviseError("soft command stayed in the editor");
      if (!(await sessionRuntime(deps.run).key(deps.config.leadPane, "enter"))) throw new TransientSuperviseError("soft command send failed");
      enters++;
    } else if ((after.revision !== undefined && after.revision !== pane.revision) || screen !== before) return;
    if (deps.clock.now() >= deadline) break;
    await deps.clock.sleep(200);
  }
  throw new TransientSuperviseError("soft command showed no completed screen change");
};

/**
 * After /new omo writes the new session's header at once, its model entry while still starting, and its startup
 * bookkeeping right after; the session takes input once that file has stopped growing for this long.
 */
export const SOFT_SESSION_SETTLE_MS = 1_000;

/** The model (`provider/modelId`) and thinking level a session file last recorded. */
export const sessionModel = (file: string): { model?: string; thinking?: string } => {
  let model: string | undefined;
  let thinking: string | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"model_change"') && !line.includes('"thinking_level_change"')) continue;
    let entry: { type?: unknown; provider?: unknown; modelId?: unknown; thinkingLevel?: unknown };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") model = `${entry.provider}/${entry.modelId}`;
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") thinking = entry.thinkingLevel;
  }
  return { model, thinking };
};

/**
 * After /new omo's terminal integration can release the pane's agent while the old session shuts down and report it again
 * once the new one has started (about two seconds). For this long a missing agent whose process still holds the pane's
 * foreground is that switch, not a dead lead.
 */
export const SOFT_RELEASE_GRACE_MS = 10_000;

/**
 * One soft wait's liveness: true when the agent is ready, false during a release gap. Throws at once when only the
 * shell is left in the pane, and once the agent has been missing for longer than the grace.
 */
const softLiveCheck = (deps: FlowDeps): (() => Promise<boolean>) => {
  let missingSince: number | undefined;
  return async () => {
    if (await softLive(deps)) {
      missingSince = undefined;
      return true;
    }
    const now = deps.clock.now();
    missingSince ??= now;
    const info = await processInfo(deps);
    if (!info || plainShell(info)) throw new TransientSuperviseError("reused lead is not live");
    if (now - missingSince >= SOFT_RELEASE_GRACE_MS) throw new TransientSuperviseError(`reused lead is not live after ${SOFT_RELEASE_GRACE_MS / 1000}s`);
    return false;
  };
};

/** The new session's file once it has started and settled with its agent back, or undefined at the deadline. */
export const softSessionStarted = async (deps: FlowDeps, old: string, startedAt: number | undefined): Promise<string | undefined> => {
  const pane = await paneRow(deps.run, deps.config.leadPane);
  const dir = sessionDirFor(deps.tunables.sessionsDir, pane?.cwd ?? deps.config.leadCwd);
  const deadline = deps.clock.now() + STARTUP_EVIDENCE_MS;
  const live = softLiveCheck(deps);
  let seen: { readonly file: string; readonly size: number; readonly since: number } | undefined;
  while (deps.clock.now() < deadline) {
    // The next command is typed only into a settled new session whose agent is back.
    const ready = await live();
    let found: { readonly file: string; readonly size: number } | undefined;
    for (const name of readdirSync(dir)) {
      const id = /(?:^|_)([0-9a-f-]{36})\.jsonl$/.exec(name)?.[1];
      if (!id || id === old) continue;
      const file = join(dir, name);
      try {
        const stat = statSync(file);
        if (startedAt !== undefined && stat.mtimeMs < startedAt) continue;
        if (readFileSync(file, "utf8").includes('"type":"model_change"')) found = { file, size: stat.size };
      } catch (e) {
        if (e instanceof Error && "code" in e && e.code === "ENOENT") continue;
        throw e;
      }
    }
    if (found && seen?.file === found.file && seen.size === found.size) {
      if (ready && deps.clock.now() - seen.since >= SOFT_SESSION_SETTLE_MS) return found.file;
    } else seen = found && { ...found, since: deps.clock.now() };
    await deps.clock.sleep(200);
  }
  return undefined;
};

/** A new session must have persisted the unique startup-file pointer, not merely a holder directory. */
export const softEvidence = async (deps: FlowDeps, old: string, markers: readonly string[], startedAt: number | undefined): Promise<string | undefined> => {
  const pane = await paneRow(deps.run, deps.config.leadPane);
  const dir = sessionDirFor(deps.tunables.sessionsDir, pane?.cwd ?? deps.config.leadCwd);
  const deadline = deps.clock.now() + STARTUP_EVIDENCE_MS;
  const live = softLiveCheck(deps);
  for (let attempt = 0; attempt <= STARTUP_EVIDENCE_MS / 500; attempt++) {
    for (const name of (await live()) ? readdirSync(dir) : []) {
      if (deps.clock.now() >= deadline) return undefined;
      const id = /(?:^|_)([0-9a-f-]{36})\.jsonl$/.exec(name)?.[1];
      if (!id || id === old) continue;
      const file = join(dir, name);
      try {
        if (startedAt !== undefined && statSync(file).mtimeMs < startedAt) continue;
        if (deps.clock.now() >= deadline) return undefined;
        const text = readFileSync(file, "utf8");
        if (markers.some((marker) => text.includes(marker)) && deps.clock.now() < deadline) return id;
      } catch (e) {
        if (e instanceof Error && "code" in e && e.code === "ENOENT") continue;
        throw e;
      }
    }
    if (deps.clock.now() >= deadline) break;
    await deps.clock.sleep(500);
  }
  return undefined;
};
