import { RunnerUnavailable, type RunnerCall } from "./call.ts";
import { LOCAL_RUNNER } from "./serve.ts";
import type { RunnerRow } from "./hub.ts";
import type { HerdrAction } from "./protocol.ts";

/**
 * `dori runner herdr <start|restart|stop|status> --machine <label> [--yes]`: sends `host.herdr` (proto 4) to the
 * machine's runner through the supervisor's CLI relay. `restart` and `stop` end herdr and every lane pane on that
 * machine, so they print the open lanes they end and run only with `--yes`. A proto-3 runner is refused before
 * anything is sent: it has no `host.herdr`.
 */

export const HERDR_ACTIONS: readonly HerdrAction[] = ["start", "restart", "stop", "status"];
export const HERDR_CLI_USAGE = "usage: dori runner herdr start|restart|stop|status --machine LABEL [--yes]";
const HOST_HERDR_PROTO = 4;

export type HerdrCliDeps = {
  readonly calls: Pick<RunnerCall, "call">;
  /** The supervisor's hub rows (proto per runner). */
  readonly rows: () => readonly RunnerRow[];
  /** The open lanes and the runner each belongs to (absent: a record from before runners, the local machine). */
  readonly lanes: () => Promise<readonly { readonly key: string; readonly runner?: string }[]>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

const tag = (label: string): string => `machine=${label}`;

const unsupported = (label: string, proto: number): string =>
  `RUNNER_HERDR_UNSUPPORTED ${tag(label)} the runner speaks proto ${proto}; host.herdr needs proto ${HOST_HERDR_PROTO}: `
  + (label === LOCAL_RUNNER ? "restart the supervisor on the updated checkout" : `dori runner install --machine ${label} upgrades it`);

/** Returns the exit code: 0 done, 1 the runner failed the action, 2 refused before sending. */
export const runnerHerdrMain = async (input: { readonly action: string | undefined; readonly machine: string; readonly yes: boolean }, deps: HerdrCliDeps): Promise<number> => {
  const action = HERDR_ACTIONS.find((a) => a === input.action);
  if (!action) { deps.err(HERDR_CLI_USAGE); return 2; }
  const label = input.machine;
  const proto = deps.rows().find((row) => row.label === label)?.proto;
  if (proto !== undefined && proto < HOST_HERDR_PROTO) { deps.err(unsupported(label, proto)); return 2; }
  if (action === "restart" || action === "stop") {
    const lanes = (await deps.lanes()).filter((lane) => (lane.runner ?? LOCAL_RUNNER) === label).map((lane) => lane.key);
    const lead = label === LOCAL_RUNNER ? " and the lead pane" : "";
    deps.out(`RUNNER_HERDR_LANES ${tag(label)} ${action} ends herdr${lead} and these ${lanes.length} open lanes: ${lanes.length ? lanes.join(", ") : "none"}`);
    if (!input.yes) {
      deps.err(`RUNNER_HERDR_CONFIRM ${action} on ${tag(label)} ends every pane herdr runs there; rerun with --yes to go ahead`);
      return 2;
    }
  }
  let answer: Awaited<ReturnType<RunnerCall["call"]>>;
  try {
    answer = await deps.calls.call(label, "host.herdr", { action });
  } catch (error) {
    if (!(error instanceof RunnerUnavailable)) throw error;
    if (error.why === "outdated") deps.err(unsupported(label, proto ?? HOST_HERDR_PROTO - 1));
    else deps.err(error.message);
    return 2;
  }
  if (answer.state !== "verified") {
    deps.err(`RUNNER_HERDR_FAILED ${tag(label)} action=${action} ${answer.state}: ${answer.detail}`);
    return 1;
  }
  const r = answer.result as { readonly state: string; readonly instance?: string; readonly managed: boolean; readonly paused: boolean };
  deps.out(`RUNNER_HERDR ${tag(label)} action=${action} state=${r.state} managed=${r.managed} paused=${r.paused}${r.instance ? ` server=${r.instance.replace(/\s/g, "_")}` : ""} ${answer.detail}`);
  if (action === "restart") deps.out(`RUNNER_HERDR_NOTE ${tag(label)} the recovery sweep relaunches the open lanes there in new tabs, resuming their sessions`);
  if (action === "stop") deps.out(`RUNNER_HERDR_NOTE ${tag(label)} lane recovery there is held until dori runner herdr start --machine ${label}`);
  return 0;
};
