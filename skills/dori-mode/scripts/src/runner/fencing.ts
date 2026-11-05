/**
 * Pure fencing decisions for runner `gen` and supervisor `epoch`. Nothing here touches disk, sockets or clocks;
 * callers persist the inputs and act on the returned decision.
 */

export type EffectEpochDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "RUNNER_CMD_REJECTED"; readonly rule: "stale-epoch"; readonly detail: string };

/**
 * Runner side. Call immediately before a command's effect, with `maxEpoch` freshly read from the runner state
 * (not a value cached when the command arrived). A command stamped with an epoch below the highest epoch seen
 * comes from a superseded supervisor and must not run.
 */
export function checkEffectEpoch(cmdEpoch: number, maxEpoch: number): EffectEpochDecision {
  if (cmdEpoch >= maxEpoch) return { ok: true };
  return {
    ok: false,
    code: "RUNNER_CMD_REJECTED",
    rule: "stale-epoch",
    detail: `RUNNER_CMD_REJECTED stale-epoch cmdEpoch=${cmdEpoch} maxEpoch=${maxEpoch}`,
  };
}

/** What the supervisor has stored for a label. Both fields are absent before the first accepted hello. */
export type StoredRunner = { readonly hostId?: string; readonly maxGen?: number };

export type HelloIdentity = { readonly label: string; readonly hostId: string; readonly gen: number };

export type HelloDecision =
  /** No conflicting history: register the connection and store hostId and gen. */
  | { readonly action: "accept" }
  /** Same host, higher gen: the runner restarted. Close the previous connection (if any), then register this one. */
  | { readonly action: "replace" }
  | { readonly action: "conflict"; readonly code: "RUNNER_CONFLICT"; readonly reason: "gen-regressed" | "host-mismatch"; readonly detail: string };

/**
 * Supervisor side, on a hello whose signature already verified.
 *
 * - nothing stored, or no hostId stored: accept.
 * - different hostId for the same label: conflict `host-mismatch`.
 * - same hostId, no maxGen stored (after `resetGen`): accept.
 * - same hostId, `gen < maxGen`: conflict `gen-regressed` (state restored from a backup, or a stale process).
 * - same hostId, `gen == maxGen`: the same runner process. With `connectedGen === gen` another live connection
 *   already holds that generation, so this one is a duplicate: conflict `gen-regressed`. Otherwise the earlier
 *   connection is gone and this is a plain reconnect: accept.
 * - same hostId, `gen > maxGen`: replace.
 *
 * `connectedGen` is the gen of the live connection currently registered for this label, if any.
 */
export function decideHello(stored: StoredRunner | undefined, hello: HelloIdentity, connectedGen?: number): HelloDecision {
  if (stored?.hostId === undefined) return { action: "accept" };
  if (stored.hostId !== hello.hostId) {
    return {
      action: "conflict",
      code: "RUNNER_CONFLICT",
      reason: "host-mismatch",
      detail: `RUNNER_CONFLICT host-mismatch runner=${hello.label} stored=${stored.hostId} hello=${hello.hostId}`,
    };
  }
  const maxGen = stored.maxGen;
  if (maxGen === undefined) return { action: "accept" };
  if (hello.gen > maxGen) return { action: "replace" };
  if (hello.gen === maxGen && connectedGen !== hello.gen) return { action: "accept" };
  return {
    action: "conflict",
    code: "RUNNER_CONFLICT",
    reason: "gen-regressed",
    detail: `RUNNER_CONFLICT gen-regressed runner=${hello.label} maxGen=${maxGen} hello=${hello.gen}`,
  };
}

/**
 * `dori runner reset-gen <label>`: forgets the stored maxGen and keeps the hostId, so the next hello from the
 * same host is accepted at whatever gen it carries, while a different host is still a conflict.
 */
export function resetGen(stored: StoredRunner): StoredRunner {
  return stored.hostId === undefined ? {} : { hostId: stored.hostId };
}

/** The record to persist after an accepted or replacing hello: the highest gen seen so far. */
export function recordHello(stored: StoredRunner | undefined, hello: HelloIdentity): Required<StoredRunner> {
  return { hostId: hello.hostId, maxGen: Math.max(stored?.maxGen ?? 0, hello.gen) };
}
