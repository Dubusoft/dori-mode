import type { SecretGrant } from "./lane-socket.ts";
import { secretsSupported, SECRET_PROTO } from "./protocol.ts";
import { secretGranter, type SecretGranterDeps } from "./secret-grant.ts";
import { secretCommandRunner, type SecretRunnerDeps, type SecretRunResult } from "./secret-run.ts";
import { SECRET_ANSWER_TYPE, type SecretFrame, type SecretReplyContext } from "./serve.ts";
import { laneToodoRequest, type LaneToodoReader } from "../toodo-lane-read.ts";

export type LaneGranter = (key: string, names: readonly string[]) => Promise<SecretGrant>;
export type LaneCommandRunner = (key: string, op: string) => Promise<SecretRunResult>;
export type SupervisorSecretDeps = {
  readonly laneOwner: (key: string) => string | undefined | Promise<string | undefined>;
  readonly runnerUnsandboxed: (label: string) => boolean;
  readonly granter: (label: string, repo: string | undefined) => LaneGranter;
  readonly commandRunner?: (label: string, repo: string | undefined) => LaneCommandRunner;
  /** Answers a remote lane's `toodo.read` (toodo-lane-read.ts); absent: RUNNER_SECRET_UNSUPPORTED. */
  readonly toodoReader?: LaneToodoReader;
  readonly log: (line: string) => void;
};

/**
 * Authenticate the link, lane ownership and sandbox before returning sealed store values or host output. A Toodo read
 * hands out no secret, so it needs lane ownership but not a sandboxed runner.
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
    if (frame.type === "toodo.read") {
      if (!deps.toodoReader) { refuse("RUNNER_SECRET_UNSUPPORTED", "this supervisor does not serve Toodo reads"); return; }
      const request = laneToodoRequest(frame.body.op, frame.body.id, frame.body.query);
      if (!request) { refuse("TOODO_LANE_BAD_REQUEST", "toodo.read needs op get [id], search with a query, or guidelines"); return; }
      const result = await deps.toodoReader(key, request);
      if (!result.ok) { refuse(result.code, result.detail); return; }
      ctx.reply(type, { rid, ok: true, sealed: session.sealSecret("s2r", { ...ctx.head, type, rid }, JSON.stringify({ text: result.text, truncated: result.truncated })) });
      return;
    }
    if (deps.runnerUnsandboxed(label)) {
      refuse("RUNNER_SECRET_DENIED", `runner ${label} runs lanes unsandboxed (runners.${label}.allowUnsandboxed); it gets no secrets`);
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
    const plaintext = JSON.stringify({ values: grant.values });
    const sealed = session.sealSecret("s2r", { ...ctx.head, type, rid }, plaintext);
    ctx.reply(type, { rid, ok: true, sealed });
  } catch (e) {
    refuse("RUNNER_SECRET_FAILED", (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200));
  }
};


export const supervisorGranter = (deps: SecretGranterDeps) => (_label: string, _repo: string | undefined): LaneGranter => secretGranter(deps);

export type SupervisorCommandRunnerDeps = Omit<SecretRunnerDeps, "laneRepo">;
export const supervisorCommandRunner = (deps: SupervisorCommandRunnerDeps) => (label: string, repo: string | undefined): LaneCommandRunner => {
  const runOp = secretCommandRunner({ ...deps, log: (line) => { deps.log(line.replace(/^(\S+) /, `$1 runner=${label} `)); } });
  return (key, op) => runOp(key, op, repo);
};
