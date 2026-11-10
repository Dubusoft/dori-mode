/**
 * The runner half of `dori update` (design 6.3). The supervisor is always updated and restarted first (it accepts the
 * runner protocol it speaks and the one before), then the runners one at a time: install the new bundle on one runner,
 * wait for its hello with a higher gen (the restarted process), and only then go to the next. A runner that fails logs
 * one `RUNNER_UPGRADE_FAILED runner=<label> ...` line, keeps the old version and stays connected on the previous
 * protocol; the rollout goes on with the next runner.
 */

export type UpgradeStep = { readonly ok: true; readonly version?: string } | { readonly ok: false; readonly detail: string };

export type UpgradeDeps = {
  readonly labels: readonly string[];
  readonly install: (label: string) => Promise<UpgradeStep>;
  /** Resolves true once the runner said hello with a gen above the one it had before the install. */
  readonly confirm: (label: string) => Promise<boolean>;
  readonly log: (line: string) => void;
};

/**
 * The worker runners a rollout installs: every runner but `local` whose last hello did not report `want` (the supervisor
 * checkout's version). A runner that already runs `want` is skipped, so the rollout can run on every `dori update` and
 * finishes one that an earlier update left halfway. Without a known `want` every worker is installed.
 */
export const staleRunnerLabels = (rows: readonly { readonly label: string; readonly version?: string }[], local: string, want: string | undefined): string[] =>
  rows.filter((r) => r.label !== local && (want === undefined || r.version !== want)).map((r) => r.label);

export const upgradeRunners = async (deps: UpgradeDeps): Promise<{ readonly upgraded: number; readonly failed: readonly string[] }> => {
  let upgraded = 0;
  const failed: string[] = [];
  for (const label of deps.labels) {
    const step = await deps.install(label).catch((e: unknown): UpgradeStep => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
    const detail = !step.ok ? step.detail : (await deps.confirm(label)) ? undefined : "no hello with a higher gen after the install";
    if (detail !== undefined) {
      deps.log(`RUNNER_UPGRADE_FAILED runner=${label} ${detail.replace(/\s+/g, " ")}`);
      failed.push(label);
      continue;
    }
    upgraded += 1;
    deps.log(`RUNNER_UPGRADED runner=${label}${step.ok && step.version ? ` version=${step.version}` : ""}`);
  }
  return { upgraded, failed };
};
