export const RUNNER_UNIT = "dori-runner.service";
export const LAUNCHD_LABEL = "com.dori.runner";

/** The runner CLI on a worker: the install wrapper when present, else the bundle run with the bun the login would find. */
export const remoteRunnerCli = (args: string): string =>
  `if [ -x "$HOME/.dori/runner/bin/dori" ]; then "$HOME/.dori/runner/bin/dori" ${args}; else PATH="$HOME/.bun/bin:$PATH" bun "$HOME/.dori/runner/bin/dori.js" ${args}; fi`;

/** Restarts or stops the runner's service on a worker, through launchd on Darwin and systemd elsewhere; the exit status is the service manager's. */
export const remoteRunnerService = (action: "restart" | "stop"): string => {
  const darwin = action === "restart"
    ? `launchctl kickstart -k "$D/${LAUNCHD_LABEL}"`
    : `launchctl disable "$D/${LAUNCHD_LABEL}" && launchctl bootout "$D/${LAUNCHD_LABEL}"`;
  return `if [ "$(uname -s)" = Darwin ]; then D=$(cat "$HOME/.dori/runner/launchd-domain" 2>/dev/null || echo "gui/$(id -u)"); ${darwin}; else systemctl --user ${action} ${RUNNER_UNIT}; fi`;
};
