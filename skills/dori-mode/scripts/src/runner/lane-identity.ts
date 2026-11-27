/**
 * Lane mode (design 5, D11): the process is lane `DORI_LANE_KEY` when that variable names one (`dori launch` sets it in
 * every lane it starts), else the lead. Reads nothing but the environment, so the CLI's lane-mode gate stays free of
 * supervisor state. An agent started without it (a pane registered with `dori adopt`) runs in lead mode.
 */
export const resolveLaneContext = (env: Readonly<Record<string, string | undefined>>): string | undefined =>
  env.DORI_LANE_KEY?.trim() || undefined;
