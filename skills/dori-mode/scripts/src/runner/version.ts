import type { Runner } from "../run.ts";

/** The global `buildBundle` defines (`bun build --define`) with the source's short git SHA. */
export const RUNNER_VERSION_DEFINE = "DORI_RUNNER_VERSION";

declare const DORI_RUNNER_VERSION: string | undefined;

/** The short git SHA of the checkout at `dir`, or undefined when `dir` is not in one or git fails. */
export const gitVersion = async (run: Runner, dir: string): Promise<string | undefined> => {
  const head = await run(["git", "-C", dir, "rev-parse", "--short", "HEAD"], { timeoutMs: 5_000 }).catch(() => undefined);
  return head?.code === 0 ? head.out.trim() || undefined : undefined;
};

/**
 * The version a runner reports in its hello. An installed runner is a bundle under `~/.dori/runner/bin` with no git
 * checkout around it, so the bundle carries the SHA it was built from; a runner started from a checkout asks git.
 */
export const runnerVersion = async (run: Runner, dir: string): Promise<string | undefined> =>
  (typeof DORI_RUNNER_VERSION === "string" && DORI_RUNNER_VERSION) || gitVersion(run, dir);
