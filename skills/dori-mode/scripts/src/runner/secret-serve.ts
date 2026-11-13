import type { SecretCommand, SecretRule } from "../config.ts";
import { secretRequester } from "../owner-decisions.ts";
import type { SecretStore } from "../secret-store.ts";
import { SECRET_PUT_MAX_BYTES, type SecretGrant, type SecretPutResult } from "./lane-socket.ts";
import { secretsSupported, SECRET_PROTO, SECRET_PUT_PROTO } from "./protocol.ts";
import { appendSecretAudit, secretAuditPath, secretDepositor, secretGranter } from "./secret-grant.ts";
import { secretCommandRunner, type SecretRunnerDeps, type SecretRunResult } from "./secret-run.ts";
import { SECRET_ANSWER_TYPE, type SecretFrame, type SecretReplyContext } from "./serve.ts";
import { SECRET_NAME } from "../secret-name.ts";

/**
 * The supervisor side of remote secrets: answers a remote runner's `secret.get` with a `secret.value` whose values
 * travel only inside a box sealed with the connection's session (direction `s2r`). The supervisor decides with its own
 * registry, config and store; the runner's frame only names the lane, the names and the lane's repo. Nothing here logs
 * or puts in a `detail` a value.
 */

/** A lane granter for one runner: phase 1's `secretGranter` (lane socket) shape. */
export type LaneGranter = (key: string, names: readonly string[]) => Promise<SecretGrant>;

/** A secret command runner for one runner's lanes: secret-run.ts `secretCommandRunner` shape, repo bound. */
export type LaneCommandRunner = (key: string, op: string) => Promise<SecretRunResult>;

/** Stores a value for one runner's lanes: secret-grant.ts `secretDepositor` shape, repo bound. */
export type LaneDepositor = (key: string, name: string, value: string) => Promise<SecretPutResult>;

export type SupervisorSecretDeps = {
  /** The runner that owns lane `key` in the registry (`Lane.runner`), undefined when no open lane has that key. */
  readonly laneOwner: (key: string) => string | undefined | Promise<string | undefined>;
  /** Whether config `runners.<label>.allowUnsandboxed` is true: such a runner's lanes never get secrets. */
  readonly runnerUnsandboxed: (label: string) => boolean;
  /** The phase-1 granter for `label`'s lanes, with `repo` (from the frame) as the lane's repo. */
  readonly granter: (label: string, repo: string | undefined) => LaneGranter;
  /** Runs `secretCommands.<op>` on this host for `label`'s lanes, with `repo` (from the frame); absent: `secret.run` is UNSUPPORTED. */
  readonly commandRunner?: (label: string, repo: string | undefined) => LaneCommandRunner;
  /** Stores a value `label`'s lane made (`secret.put`), with `repo` (from the frame); absent: `secret.put` is UNSUPPORTED. */
  readonly depositor?: (label: string, repo: string | undefined) => LaneDepositor;
  readonly log: (line: string) => void;
};

/**
 * `HubHooks.onSecret`. Rules, in order: no session -> `RUNNER_SECRET_UNSUPPORTED`; connection proto < 6 ->
 * `RUNNER_SECRET_OUTDATED`; lane missing or owned by another runner -> `RUNNER_SECRET_DENIED` and log
 * `RUNNER_FORGED_SECRET runner=<label> key=<key>`; unsandboxed runner -> `RUNNER_SECRET_DENIED`; then the granter
 * (`secret.get`) or the command runner (`secret.run`; `RUNNER_SECRET_UNSUPPORTED` without one). A grant is answered `ok`
 * with `sealed` = JSON `{values, kinds?}` sealed `s2r` under aad `{runner, gen, epoch, type: "secret.value", rid}`; a run
 * with `sealed` = JSON `{exitCode, stdout, stderr, truncated}` under aad type `"secret.run.result"`. A `secret.put` (proto
 * 8, else `RUNNER_SECRET_OUTDATED`) opens its `r2s` box under the frame's own aad `{runner, gen, epoch, type:
 * "secret.put", rid}` and goes to the depositor; its `secret.put.result` carries `created`/`backend`, nothing sealed.
 * Refusals go unsealed with code and detail. The returned promise settles once the answer went out.
 */
export const supervisorSecretHandler = (deps: SupervisorSecretDeps) => async (label: string, frame: SecretFrame, ctx: SecretReplyContext): Promise<void> => {
  const type = SECRET_ANSWER_TYPE[frame.type];
  const { rid, key } = frame.body;
  const refuse = (code: string, detail: string): void => { ctx.reply(type, { rid, ok: false, code, detail }); };
  try {
    const session = ctx.session;
    if (!session) { refuse("RUNNER_SECRET_UNSUPPORTED", "unauthenticated link"); return; }
    if (!secretsSupported(ctx.proto)) { refuse("RUNNER_SECRET_OUTDATED", `runner speaks proto ${ctx.proto}; secrets need proto ${SECRET_PROTO}`); return; }
    if (await deps.laneOwner(key) !== label) {
      deps.log(`RUNNER_FORGED_SECRET runner=${label} key=${key}`);
      refuse("RUNNER_SECRET_DENIED", `${key} is not a lane of runner ${label}`);
      return;
    }
    if (deps.runnerUnsandboxed(label)) {
      refuse("RUNNER_SECRET_DENIED", `runner ${label} runs lanes unsandboxed (runners.${label}.allowUnsandboxed); it gets no secrets`);
      return;
    }
    if (frame.type === "secret.put") {
      if (!deps.depositor) { refuse("RUNNER_SECRET_UNSUPPORTED", "storing lane secrets is not enabled"); return; }
      if (ctx.proto < SECRET_PUT_PROTO) { refuse("RUNNER_SECRET_OUTDATED", `runner speaks proto ${ctx.proto}; secret put needs proto ${SECRET_PUT_PROTO}`); return; }
      const { name, sealed } = frame.body;
      if (!SECRET_NAME.test(name)) { refuse("RUNNER_SECRET_FAILED", "secret.put names no valid secret"); return; }
      const value = session.openSecret("r2s", { runner: frame.runner, gen: frame.gen, epoch: frame.epoch, type: "secret.put", rid }, sealed);
      if (value === undefined) { refuse("RUNNER_SECRET_FAILED", "sealed value did not open"); return; }
      if (!value || Buffer.byteLength(value) > SECRET_PUT_MAX_BYTES) { refuse("RUNNER_SECRET_FAILED", `secret.put needs a value of 1 to ${SECRET_PUT_MAX_BYTES} bytes`); return; }
      const result = await deps.depositor(label, frame.body.repo)(key, name, value);
      ctx.reply("secret.put.result", result.ok ? { rid, ok: true, created: result.created, backend: result.backend } : { rid, ok: false, code: result.code, detail: result.detail });
      return;
    }
    if (frame.type === "secret.run") {
      if (!deps.commandRunner) { refuse("RUNNER_SECRET_UNSUPPORTED", "proxy execution is not enabled"); return; }
      const result = await deps.commandRunner(label, frame.body.repo)(key, frame.body.op);
      if (!result.ok) { refuse(result.code, result.detail); return; }
      const plaintext = JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated });
      ctx.reply(type, { rid, ok: true, sealed: session.sealSecret("s2r", { ...ctx.head, type, rid }, plaintext) });
      return;
    }
    const grant = await deps.granter(label, frame.body.repo)(key, frame.body.names);
    if (!grant.ok) { refuse(grant.code, grant.detail); return; }
    const kinds = (grant as { readonly kinds?: Readonly<Record<string, string>> }).kinds;
    const plaintext = JSON.stringify({ values: grant.values, ...(kinds && Object.keys(kinds).length ? { kinds } : {}) });
    const sealed = session.sealSecret("s2r", { ...ctx.head, type, rid }, plaintext);
    ctx.reply(type, { rid, ok: true, sealed });
  } catch (e) {
    refuse("RUNNER_SECRET_FAILED", (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200));
  }
};

export type SupervisorGranterDeps = {
  readonly stateDir: string;
  readonly store: Pick<SecretStore, "read">;
  /** The config `secrets` rules, read again per request. */
  readonly rules: () => Promise<Readonly<Record<string, SecretRule>>>;
  /** The config `secretCommands`, read again per request: their secrets are never offered in a secret request decision. */
  readonly commands: () => Promise<Readonly<Record<string, SecretCommand>>>;
  readonly now: () => number;
  readonly log: (line: string) => void;
};

/**
 * `SupervisorSecretDeps.granter` for production: phase 1's `secretGranter` with `runner: label`, the frame's repo,
 * and audit lines appended to `<stateDir>/secret-audit.jsonl` plus a log line
 * `RUNNER_SECRET_GRANTED|RUNNER_SECRET_DENIED runner=<label> lane=<key> names=<A,B>`. A config denial queues a secret
 * request in `<stateDir>/decisions.json` (owner-decisions.ts secretRequester), which the decision tick opens.
 */
export const supervisorGranter = (deps: SupervisorGranterDeps) => (label: string, repo: string | undefined): LaneGranter => {
  const append = appendSecretAudit(secretAuditPath(deps.stateDir), deps.log);
  return secretGranter({
    runner: label, store: deps.store, rules: deps.rules, now: deps.now, laneRepo: async () => repo,
    request: secretRequester(deps.stateDir, deps.commands, deps.now),
    audit: (entry) => {
      append(entry);
      deps.log(`${entry.allowed ? "RUNNER_SECRET_GRANTED" : "RUNNER_SECRET_DENIED"} runner=${entry.runner} lane=${entry.lane} names=${entry.names.join(",")}`);
    },
  });
};

/**
 * `SupervisorSecretDeps.depositor` for production: phase 1's `secretDepositor` with `runner: label`, the frame's repo,
 * audit lines appended to `<stateDir>/secret-audit.jsonl` plus a log line
 * `RUNNER_SECRET_STORED|RUNNER_SECRET_DENIED runner=<label> lane=<key> names=<NAME> put`.
 */
export const supervisorDepositor = (deps: Omit<SupervisorGranterDeps, "commands" | "store"> & { readonly store: Pick<SecretStore, "put"> }) => (label: string, repo: string | undefined): LaneDepositor => {
  const append = appendSecretAudit(secretAuditPath(deps.stateDir), deps.log);
  return secretDepositor({
    runner: label, store: deps.store, rules: deps.rules, now: deps.now, laneRepo: async () => repo,
    audit: (entry) => {
      append(entry);
      deps.log(`${entry.allowed ? "RUNNER_SECRET_STORED" : "RUNNER_SECRET_DENIED"} runner=${entry.runner} lane=${entry.lane} names=${entry.names.join(",")} put`);
    },
  });
};

export type SupervisorCommandRunnerDeps = SupervisorGranterDeps & Pick<SecretRunnerDeps, "spawn" | "timer" | "hostEnv" | "home" | "mint">;

/**
 * `SupervisorSecretDeps.commandRunner` for production: `secretCommandRunner` on this host with `runner: label`, the
 * frame's repo, audit lines appended to `<stateDir>/secret-audit.jsonl` and its log lines tagged `runner=<label>`.
 */
export const supervisorCommandRunner = (deps: SupervisorCommandRunnerDeps) => (label: string, repo: string | undefined): LaneCommandRunner => {
  const { stateDir: _stateDir, log, ...rest } = deps;
  const runOp = secretCommandRunner({
    ...rest, runner: label, audit: appendSecretAudit(secretAuditPath(deps.stateDir), log),
    log: (line) => { log(line.replace(/^(\S+) /, `$1 runner=${label} `)); },
  });
  return (key, op) => runOp(key, op, repo);
};
