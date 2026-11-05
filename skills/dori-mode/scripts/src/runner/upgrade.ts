/**
 * The runner half of `dori update` (design 6.3). The supervisor is always updated and restarted first (it accepts the
 * runner protocol it speaks and the one before), then the runners one at a time: install the new bundle on one runner,
 * wait for its hello with a higher gen (the restarted process), and only then go to the next. The first runner that
 * fails stops the rollout with one `RUNNER_UPGRADE_FAILED runner=<label> ...` line; the runners not reached keep the
 * old version and stay connected on the previous protocol.
 */

export type UpgradeStep = { readonly ok: true; readonly version?: string } | { readonly ok: false; readonly detail: string };

export type UpgradeDeps = {
  readonly labels: readonly string[];
  readonly install: (label: string) => Promise<UpgradeStep>;
  /** Resolves true once the runner said hello with a gen above the one it had before the install. */
  readonly confirm: (label: string) => Promise<boolean>;
  readonly log: (line: string) => void;
};

export const upgradeRunners = async (deps: UpgradeDeps): Promise<{ readonly upgraded: number; readonly failed?: string }> => {
  let upgraded = 0;
  for (const label of deps.labels) {
    const step = await deps.install(label).catch((e: unknown): UpgradeStep => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
    const detail = !step.ok ? step.detail : (await deps.confirm(label)) ? undefined : "no hello with a higher gen after the install";
    if (detail !== undefined) {
      deps.log(`RUNNER_UPGRADE_FAILED runner=${label} ${detail.replace(/\s+/g, " ")}; the remaining runners were not upgraded`);
      return { upgraded, failed: label };
    }
    upgraded += 1;
    deps.log(`RUNNER_UPGRADED runner=${label}${step.ok && step.version ? ` version=${step.version}` : ""}`);
  }
  return { upgraded };
};
