import type { SecretCommand, SecretRule } from "../config.ts";
import type { SecretStore } from "../secret-store.ts";
import type { SecretGrant } from "./lane-socket.ts";
import { handlesSupported, HANDLE_PROTO, secretsSupported, SECRET_PROTO } from "./protocol.ts";
import { appendSecretAudit, secretAuditPath, secretGranter } from "./secret-grant.ts";
import { SecretHandles, type HandleExchange, type HandleIssue, type SecretHandlesDeps } from "./secret-handles.ts";
import { secretCommandRunner, type SecretRunnerDeps, type SecretRunResult } from "./secret-run.ts";
import { SECRET_ANSWER_TYPE, type SecretFrame, type SecretReplyContext } from "./serve.ts";

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

/** Browser fill handles for one runner's lanes: secret-handles.ts `SecretHandles` shape. */
export type LaneHandles = {
  readonly issue: (key: string, name: string) => Promise<HandleIssue>;
  readonly exchange: (key: string, handle: string, origin: string) => Promise<HandleExchange>;
};

export type SupervisorSecretDeps = {
  /** The runner that owns lane `key` in the registry (`Lane.runner`), undefined when no open lane has that key. */
  readonly laneOwner: (key: string) => string | undefined | Promise<string | undefined>;
  /** Whether config `runners.<label>.allowUnsandboxed` is true: such a runner's lanes never get secrets. */
  readonly runnerUnsandboxed: (label: string) => boolean;
  /** The phase-1 granter for `label`'s lanes, with `repo` (from the frame) as the lane's repo. */
  readonly granter: (label: string, repo: string | undefined) => LaneGranter;
  /** Runs `secretCommands.<op>` on this host for `label`'s lanes, with `repo` (from the frame); absent: `secret.run` is UNSUPPORTED. */
  readonly commandRunner?: (label: string, repo: string | undefined) => LaneCommandRunner;
  /**
   * The browser fill handles for `label`'s lanes, `repo` from a `secret.handle` frame (undefined for an exchange), all
   * backed by one table shared by every runner; absent: `secret.handle` / `secret.exchange` are UNSUPPORTED.
   */
  readonly handles?: (label: string, repo: string | undefined) => LaneHandles;
  readonly log: (line: string) => void;
};

/**
 * `HubHooks.onSecret`. Rules, in order: no session -> `RUNNER_SECRET_UNSUPPORTED`; connection proto < 6 ->
 * `RUNNER_SECRET_OUTDATED`; lane missing or owned by another runner -> `RUNNER_SECRET_DENIED` and log
 * `RUNNER_FORGED_SECRET runner=<label> key=<key>`; unsandboxed runner -> `RUNNER_SECRET_DENIED`; then the granter
 * (`secret.get`) or the command runner (`secret.run`; `RUNNER_SECRET_UNSUPPORTED` without one). A grant is answered `ok`
 * with `sealed` = JSON `{values, kinds?}` sealed `s2r` under aad `{runner, gen, epoch, type: "secret.value", rid}`; a run
 * with `sealed` = JSON `{exitCode, stdout, stderr, truncated}` under aad type `"secret.run.result"`. Since proto 7
 * (`RUNNER_SECRET_OUTDATED` below it) `secret.handle` is answered with sealed `{handle, expiresAt}` and
 * `secret.exchange` with sealed `{value}`, each under its own result type (`RUNNER_SECRET_UNSUPPORTED` without
 * `handles`). Refusals go unsealed with code and detail. The returned promise settles once the answer went out.
 */
export const supervisorSecretHandler = (deps: SupervisorSecretDeps) => async (label: string, frame: SecretFrame, ctx: SecretReplyContext): Promise<void> => {
  const type = SECRET_ANSWER_TYPE[frame.type];
  const { rid, key } = frame.body;
  const refuse = (code: string, detail: string): void => { ctx.reply(type, { rid, ok: false, code, detail }); };
  try {
    const session = ctx.session;
    if (!session) { refuse("RUNNER_SECRET_UNSUPPORTED", "unauthenticated link"); return; }
    if (!secretsSupported(ctx.proto)) { refuse("RUNNER_SECRET_OUTDATED", `runner speaks proto ${ctx.proto}; secrets need proto ${SECRET_PROTO}`); return; }
    const handleFrame = frame.type === "secret.handle" || frame.type === "secret.exchange";
    if (handleFrame && !handlesSupported(ctx.proto)) {
      refuse("RUNNER_SECRET_OUTDATED", `runner speaks proto ${ctx.proto}; secret handles need proto ${HANDLE_PROTO}`);
      return;
    }
    if (await deps.laneOwner(key) !== label) {
      deps.log(`RUNNER_FORGED_SECRET runner=${label} key=${key}`);
      refuse("RUNNER_SECRET_DENIED", `${key} is not a lane of runner ${label}`);
      return;
    }
    if (deps.runnerUnsandboxed(label)) {
      refuse("RUNNER_SECRET_DENIED", `runner ${label} runs lanes unsandboxed (runners.${label}.allowUnsandboxed); it gets no secrets`);
      return;
    }
    if (frame.type === "secret.handle" || frame.type === "secret.exchange") {
      if (!deps.handles) { refuse("RUNNER_SECRET_UNSUPPORTED", "secret handles are not enabled"); return; }
      let plaintext: string;
      if (frame.type === "secret.handle") {
        const issued = await deps.handles(label, frame.body.repo).issue(key, frame.body.name);
        if (!issued.ok) { refuse(issued.code, issued.detail); return; }
        plaintext = JSON.stringify({ handle: issued.handle, expiresAt: issued.expiresAt });
      } else {
        const exchanged = await deps.handles(label, undefined).exchange(key, frame.body.handle, frame.body.origin);
        if (!exchanged.ok) { refuse(exchanged.code, exchanged.detail); return; }
        plaintext = JSON.stringify({ value: exchanged.value });
      }
      ctx.reply(type, { rid, ok: true, sealed: session.sealSecret("s2r", { ...ctx.head, type, rid }, plaintext) });
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
  readonly now: () => number;
  readonly log: (line: string) => void;
};

/**
 * `SupervisorSecretDeps.granter` for production: phase 1's `secretGranter` with `runner: label`, the frame's repo,
 * and audit lines appended to `<stateDir>/secret-audit.jsonl` plus a log line
 * `RUNNER_SECRET_GRANTED|RUNNER_SECRET_DENIED runner=<label> lane=<key> names=<A,B>`.
 */
export const supervisorGranter = (deps: SupervisorGranterDeps) => (label: string, repo: string | undefined): LaneGranter => {
  const append = appendSecretAudit(secretAuditPath(deps.stateDir), deps.log);
  return secretGranter({
    runner: label, store: deps.store, rules: deps.rules, now: deps.now, laneRepo: async () => repo,
    audit: (entry) => {
      append(entry);
      deps.log(`${entry.allowed ? "RUNNER_SECRET_GRANTED" : "RUNNER_SECRET_DENIED"} runner=${entry.runner} lane=${entry.lane} names=${entry.names.join(",")}`);
    },
  });
};

export type SupervisorHandlesDeps = SupervisorGranterDeps & Pick<SecretHandlesDeps, "ttlMs" | "random">;

/**
 * `SupervisorSecretDeps.handles` for production: ONE `SecretHandles` table for every remote runner (the lane-owner
 * check upstream keeps a runner to its own lanes). The lane's repo is the one its last `secret.handle` frame carried, so
 * a repos rule still matches at exchange. Audit lines go to `<stateDir>/secret-audit.jsonl` with `runner` set to the
 * lane's runner, plus a log line `RUNNER_SECRET_GRANTED|RUNNER_SECRET_DENIED runner=<label> lane=<key> names=<NAME>
 * kind=<handle.issue|handle.exchange> handleId=<id>`; neither carries a handle or a value.
 */
export const supervisorHandles = (deps: SupervisorHandlesDeps): ((label: string, repo: string | undefined) => LaneHandles) => {
  const append = appendSecretAudit(secretAuditPath(deps.stateDir), deps.log);
  const runners = new Map<string, string>();
  const repos = new Map<string, string | undefined>();
  const table = new SecretHandles({
    store: deps.store, rules: deps.rules, now: deps.now, runner: "supervisor", laneRepo: async (key) => repos.get(key),
    ...(deps.ttlMs !== undefined ? { ttlMs: deps.ttlMs } : {}), ...(deps.random ? { random: deps.random } : {}),
    audit: (entry) => {
      const tagged = { ...entry, runner: runners.get(entry.lane) ?? entry.runner };
      append(tagged);
      deps.log(`${tagged.allowed ? "RUNNER_SECRET_GRANTED" : "RUNNER_SECRET_DENIED"} runner=${tagged.runner} lane=${tagged.lane} names=${tagged.names.join(",")} kind=${tagged.kind} handleId=${tagged.handleId ?? "-"}`);
    },
  });
  return (label, repo) => ({
    issue: (key, name) => { runners.set(key, label); repos.set(key, repo); return table.issue(key, name); },
    exchange: (key, handle, origin) => { runners.set(key, label); return table.exchange(key, handle, origin); },
  });
};

export type SupervisorCommandRunnerDeps = SupervisorGranterDeps & Pick<SecretRunnerDeps, "spawn" | "timer" | "hostEnv" | "home" | "mint"> & {
  /** The config `secretCommands`, read again per request. */
  readonly commands: () => Promise<Readonly<Record<string, SecretCommand>>>;
};

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
