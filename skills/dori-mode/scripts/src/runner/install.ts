import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodedPowerShell, machineKind, sshArgv, type GuardMachine, type KindResult } from "../remote-guard.ts";
import { LANE_SANDBOX_MACOS_TEMPLATE, LANE_SANDBOX_TEMPLATE } from "../lane-sandbox-install.ts";
import { RUN_TIMEOUT_CODE, type Ran, type Runner } from "../run.ts";
import { WIN_KILL_RUNNER, WIN_TASK_NAME, WIN_TASK_PATH } from "./service.ts";
import { gitVersion, RUNNER_VERSION_DEFINE } from "./version.ts";
import type { SupervisorAuth } from "./auth.ts";
import { writeRunnerEndpoint } from "./endpoints.ts";
import { decodeFrame, encodeFrame, supervisorControl, type RunnerControlBodies } from "./protocol.ts";
import { isPrivateListen } from "./ws-transport.ts";
import { stepper, type Progress } from "./steps.ts";

/**
 * Installs or upgrades the runner on a remote Linux or macOS machine over ssh, as design 3.2 and 5.4 lay out. The ssh
 * command line is always the fixed `sh -s`; the whole install - the CLI bundle, the systemd unit, the launchd plist,
 * the one-time enrollment code and the supervisor key fingerprint - travels on ssh's stdin as one POSIX sh script
 * that branches on `uname -s`. The code and fingerprint
 * are shell variables inside that script and reach the enrolling process through a pipe from the `printf` builtin,
 * so they never appear in any process's argv on either machine. A first install returns the runner's `enroll` proof
 * on SSH stdout and exits 9 before starting a service. The installer accepts it with its local SupervisorAuth and
 * sends `enroll.ok` on stdin in a second pass, which pins the key and starts the service. No network listener or
 * running supervisor is needed for enrollment. Reinstalls with an already pinned key need only one pass.
 *
 * On both systems the script writes the bundle to `~/.dori/runner/bin/dori.js` through a temporary file and `mv`, the
 * `~/.dori/runner/bin/dori` wrapper that runs it with an absolute bun, creates `~/.dori/runner/evidence` (or tightens an
 * existing one) at 0700, and enrolls once (skipped when
 * `~/.dori/runner/keys/supervisor.pub` already exists, so a reinstall or upgrade keeps the runner's keys).
 *
 * Linux needs `bun` on the remote PATH; it writes `~/.config/systemd/user/dori-runner.service`, turns on linger, and
 * enables and restarts the unit so a new bundle takes effect.
 *
 * macOS takes `bun` from PATH, then from `~/.dori/runner/bun/bun`, `/opt/homebrew/bin`, `/usr/local/bin` or
 * `~/.bun/bin`, and otherwise downloads the latest release zip into `~/.dori/runner/bun/bun`. It writes the launchd
 * user agent `~/Library/LaunchAgents/com.dori.runner.plist` (KeepAlive), boots it into `gui/<uid>` (or `user/<uid>`
 * when no GUI session exists), kickstarts it, and records that domain in `~/.dori/runner/launchd-domain`. Nothing
 * outside `~/.dori` and that plist is touched.
 *
 * Both systems also get a herdr unit (design: runner host herdr lifecycle, section 5.3): `herdr` must be found on the
 * user's login-shell PATH, which together with the login shell becomes the unit's PATH and SHELL (every lane shell
 * herdr opens inherits them). Linux writes `~/.config/systemd/user/herdr-server.service`, which the runner unit only
 * Wants= and is After=; macOS writes the launchd agent `~/Library/LaunchAgents/com.dori.herdr.plist` (KeepAlive,
 * ThrottleInterval 30: a second `herdr server` on a taken socket exits 1 at once, so the retries are spaced out). The
 * script never stops or restarts a running herdr, since that ends every lane on the host: a herdr the unit already runs
 * is left alone (a reinstall or upgrade only rewrites the unit file), a herdr started by hand gets the unit enabled but
 * not started (macOS: `RunAtLoad` false), and only when no herdr answers is the unit started. It prints
 * `DORI_HERDR started|managed|unmanaged` on success.
 *
 * Script exit codes: 0 installed; 3 no usable `bun`; 4 unsupported OS; 5 enrollment refused or failed; 6 service
 * manager (systemd, linger or launchd) failed; 7 no `herdr` on the login PATH; 8 a POSIX shell on Windows (Git Bash,
 * MSYS, Cygwin), which `installRunner` retries as a Windows install; 9 enrollment response needed; anything else is a generic failure.
 * ssh's own 255 or a timeout is unreachable.
 *
 * Windows workers (`machineKind` says `windows`) get `windowsInstallScript` instead, with the same exit code meanings.
 * Nothing travels on ssh's stdin there (a large script streamed into a PowerShell console host's stdin does not reliably
 * finish): each pass uploads the script with scp as `.dori-runner-install-<random>.ps1` into the user's profile directory
 * (the scp start directory on Windows OpenSSH), then runs the short `winRun` encoded command over ssh, which reads that
 * file, deletes it (it holds the one-time enrollment code) and runs its text as a scriptblock.
 */

export const RUNNER_REMOTE_UNIT_TEMPLATE = join(import.meta.dir, "..", "..", "templates", "dori-runner-remote.service");
export const RUNNER_LAUNCHD_PLIST_TEMPLATE = join(import.meta.dir, "..", "..", "templates", "dori-runner-launchd.plist");
export const RUNNER_LAUNCHD_LABEL = "com.dori.runner";
export const HERDR_REMOTE_UNIT_TEMPLATE = join(import.meta.dir, "..", "..", "templates", "herdr-runner-remote.service");
export const HERDR_LAUNCHD_PLIST_TEMPLATE = join(import.meta.dir, "..", "..", "templates", "dori-herdr-launchd.plist");
export const HERDR_LAUNCHD_LABEL = "com.dori.herdr";
/** The keychain wrapper a macOS host gets as `~/.dori/runner/bin/dori-secret`. */
export const DORI_SECRET_TEMPLATE = join(import.meta.dir, "..", "..", "templates", "dori-secret.sh");
export const HERDR_UNIT = "herdr-server.service";
export const RUNNER_CLI_ENTRY = join(import.meta.dir, "bin.ts");
export const INSTALL_TIMEOUT_MS = 180_000;
/** The ssh step of a Windows pass: a first install downloads and expands the pinned Bun zip, perhaps twice. */
export const WIN_INSTALL_TIMEOUT_MS = 600_000;
const HEREDOC = "DORI_RUNNER_EOF";
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENROLL_VALUE = /^[A-Za-z0-9_:=+/.-]+$/;

export const INSTALL_EXIT = { noBun: 3, notLinux: 4, enroll: 5, systemd: 6, noHerdr: 7, windowsShell: 8, enrollPending: 9 } as const;

export type InstallFailure =
  | "RUNNER_INSTALL_UNREACHABLE"
  | "RUNNER_INSTALL_UNSUPPORTED"
  | "RUNNER_INSTALL_NO_BUN"
  | "RUNNER_INSTALL_NO_HERDR"
  | "RUNNER_INSTALL_ENROLL_FAILED"
  | "RUNNER_LISTEN_REFUSED"
  | "RUNNER_INSTALL_FAILED";
/** What the install did with herdr: started its unit, found the unit already running it, or found a herdr started by hand. */
export type HerdrInstall = "started" | "managed" | "unmanaged";
export type InstallResult =
  | { readonly ok: true; readonly version: string; readonly herdr?: HerdrInstall }
  | { readonly ok: false; readonly code: InstallFailure; readonly detail: string };

/** The herdr part of the `RUNNER_INSTALLED` line. */
export const herdrInstallNote = (herdr: HerdrInstall | undefined): string =>
  herdr === "started" ? "herdr=started (by its unit)"
    : herdr === "managed" ? "herdr=managed (its unit was already running it; left alone)"
      : herdr === "unmanaged" ? "herdr=unmanaged (running, not from its unit; the unit takes over when it stops)"
        : "herdr=unknown";

/** The herdr unit and launchd plist texts; their `@NAME@` markers are filled on the remote host. */
export type HerdrTemplates = { readonly unit: string; readonly plist: string };
const herdrTemplates = (): HerdrTemplates => ({ unit: readFileSync(HERDR_REMOTE_UNIT_TEMPLATE, "utf8"), plist: readFileSync(HERDR_LAUNCHD_PLIST_TEMPLATE, "utf8") });

export type EnrollIssue = { readonly code: string; readonly fingerprint: string; readonly reply?: string };

export type InstallDeps = {
  readonly run: Runner;
  readonly bundle: () => Promise<string>;
  /** The remote unit template text; defaults to templates/dori-runner-remote.service. */
  readonly unitTemplate?: string;
  /** The remote launchd plist template text; defaults to templates/dori-runner-launchd.plist. */
  readonly plistTemplate?: string;
  /** The herdr unit and plist texts; default to templates/herdr-runner-remote.service and templates/dori-herdr-launchd.plist. */
  readonly herdrTemplates?: HerdrTemplates;
  /** The Windows payload templates; default to the files under templates/. */
  readonly windowsTemplates?: WindowsTemplates;
  /** The lane-sandbox wrapper a Linux host gets as `~/.dori/runner/bin/lane-sandbox`; defaults to templates/lane-sandbox.sh. */
  readonly laneSandbox?: string;
  /** The lane-sandbox wrapper a macOS host gets there instead; defaults to templates/lane-sandbox-macos.sh. */
  readonly laneSandboxMacos?: string;
  /** How the machine runs commands; defaults to `machineKind`. */
  readonly kind?: (run: Runner, machine: GuardMachine) => Promise<KindResult>;
  /** Receives a `RUNNER_STEP` line as each step starts, finishes or fails. */
  readonly progress?: Progress;
};

export type InstallRequest = {
  readonly machine: GuardMachine;
  readonly label: string;
  /** The private IP host:port the worker listens on. */
  readonly listenAddress: string;
  readonly stateDir: string;
  /** Issues the one-time enrollment code; called only after every input checked out. */
  readonly issue: () => EnrollIssue;
  /** Accepts the request received over SSH stdout using the installer's SupervisorAuth. */
  readonly enroll: SupervisorAuth["enroll"];
  /** The lead's agent command: the `default` profile of the starter runner-config.json the script writes when there is none. */
  readonly agentCommand: readonly string[];
};

export const bundleVersion = (bundle: string): string => createHash("sha256").update(bundle).digest("hex").slice(0, 12);

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The unit text for `label` and `listenAddress`; `@BUN@` and `@PATH@` are filled on the remote host by the script. The
 * template uses `@NAME@` markers rather than setup's `{{NAME}}`, because setup does not render it.
 */
export const remoteUnit = (template: string, label: string, listenAddress: string): string =>
  template.replaceAll("@LABEL@", label).replaceAll("@LISTEN@", listenAddress);

const BUN_RELEASE = "https://github.com/oven-sh/bun/releases/latest/download";

export const installScript = (
  bundle: string,
  unit: string,
  label: string,
  listenAddress: string,
  issue: EnrollIssue,
  plist: string = remoteUnit(readFileSync(RUNNER_LAUNCHD_PLIST_TEMPLATE, "utf8"), label, listenAddress),
  agentCommand: readonly string[] = [],
  herdr: HerdrTemplates = herdrTemplates(),
  laneSandbox: string = readFileSync(LANE_SANDBOX_TEMPLATE, "utf8"),
  laneSandboxMacos: string = readFileSync(LANE_SANDBOX_MACOS_TEMPLATE, "utf8"),
  doriSecret: string = readFileSync(DORI_SECRET_TEMPLATE, "utf8"),
): string => {
  for (const text of [bundle, unit, plist, herdr.unit, herdr.plist, laneSandbox, laneSandboxMacos, doriSecret]) {
    if (text.split("\n").some((line) => line.replace(/\r$/, "") === HEREDOC)) throw new Error(`install payload contains the heredoc delimiter ${HEREDOC}`);
  }
  const body = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);
  return [
    "set -u",
    "umask 077",
    "OS=$(uname -s)",
    `case "$OS" in Linux|Darwin) ;; MINGW*|MSYS*|CYGWIN*) exit ${INSTALL_EXIT.windowsShell} ;; *) exit ${INSTALL_EXIT.notLinux} ;; esac`,
    // The login shell's PATH (an ssh command gets a non-login one, without what the user's profile adds), read past
    // whatever the profile prints. herdr is looked up on it before anything is written, and it becomes the herdr
    // unit's PATH, which the lane shells inherit.
    'SH=${SHELL:-/bin/sh}',
    String.raw`LP=$("$SH" -lc 'printf "\nDORI_LOGIN_PATH=%s\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^DORI_LOGIN_PATH=//p' | tail -n 1)`,
    '[ -n "$LP" ] || LP=$PATH',
    `HERDR=$(PATH="$LP:$PATH"; command -v herdr) || exit ${INSTALL_EXIT.noHerdr}`,
    // A herdr already answering is never stopped or restarted here: that would end every lane on the host.
    'if "$HERDR" workspace list </dev/null >/dev/null 2>&1; then HUP=1; else HUP=0; fi',
    String.raw`esc() { printf '%s' "$1" | sed -e 's/[\|&]/\\&/g'; }`,
    // A plist value is XML text as well.
    String.raw`xesc() { esc "$(printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"; }`,
    'R="$HOME/.dori/runner"',
    'if [ "$OS" = Linux ]; then',
    `  BUN=$(command -v bun) || exit ${INSTALL_EXIT.noBun}`,
    '  mkdir -p "$R/bin" "$HOME/.config/systemd/user" || exit 1',
    "else",
    "  BUN=$(command -v bun) || BUN=",
    '  if [ -z "$BUN" ]; then',
    '    for B in "$R/bun/bun" /opt/homebrew/bin/bun /usr/local/bin/bun "$HOME/.bun/bin/bun"; do',
    '      if [ -x "$B" ]; then BUN=$B; break; fi',
    "    done",
    "  fi",
    '  if [ -z "$BUN" ]; then',
    `    case "$(uname -m)" in arm64) A=aarch64 ;; x86_64) A=x64 ;; *) exit ${INSTALL_EXIT.noBun} ;; esac`,
    `    mkdir -p "$R/bun" || exit ${INSTALL_EXIT.noBun}`,
    `    chmod 700 "$HOME/.dori" "$R" "$R/bun" || exit ${INSTALL_EXIT.noBun}`,
    `    T=$(mktemp -d "$R/bun-download.XXXXXX") || exit ${INSTALL_EXIT.noBun}`,
    `    curl -fsSL -o "$T/bun.zip" "${BUN_RELEASE}/bun-darwin-$A.zip" </dev/null && unzip -q "$T/bun.zip" -d "$T" </dev/null && mv -f "$T/bun-darwin-$A/bun" "$R/bun/bun" && chmod 700 "$R/bun/bun" || { rm -rf "$T"; exit ${INSTALL_EXIT.noBun}; }`,
    '    rm -rf "$T"',
    '    BUN="$R/bun/bun"',
    "  fi",
    `  "$BUN" --version </dev/null >/dev/null 2>&1 || exit ${INSTALL_EXIT.noBun}`,
    '  mkdir -p "$R/bin" "$HOME/Library/LaunchAgents" || exit 1',
    "fi",
    // `evidence/` holds lane QA artifacts on the host. It is created here, and an existing one (left 0755 by a tool that
    // made it) is tightened, since the runner refuses to start on any runner directory that is not 0700.
    'mkdir -p "$R/evidence" || exit 1',
    'chmod 700 "$HOME/.dori" "$R" "$R/bin" "$R/evidence" || exit 1',
    // Lanes run sandboxed through the lane-sandbox wrapper, installed beside the runner's own files: bubblewrap on Linux,
    // Seatbelt (sandbox-exec) on macOS. It needs no extra paths here: the runner socket, the lane's brief and token file
    // and its cwd are handled by the wrapper itself, and the lead's verify directory is not on this host.
    'if [ "$OS" = Linux ]; then',
    `cat > "$R/bin/lane-sandbox.tmp" <<'${HEREDOC}' || exit 1`,
    `${body(laneSandbox)}${HEREDOC}`,
    "else",
    `cat > "$R/bin/lane-sandbox.tmp" <<'${HEREDOC}' || exit 1`,
    `${body(laneSandboxMacos)}${HEREDOC}`,
    "fi",
    // 0700 like `dori`: the runner refuses to start on a runner directory holding anything wider (fs-safety.ts).
    'chmod 700 "$R/bin/lane-sandbox.tmp" && mv -f "$R/bin/lane-sandbox.tmp" "$R/bin/lane-sandbox" || exit 1',
    // On macOS, lanes read the owner's dori.<name> login-keychain items only through dori-secret, which hands a value to
    // one command's environment and never prints it.
    'if [ "$OS" = Darwin ]; then',
    `cat > "$R/bin/dori-secret.tmp" <<'${HEREDOC}' || exit 1`,
    `${body(doriSecret)}${HEREDOC}`,
    '  chmod 700 "$R/bin/dori-secret.tmp" && mv -f "$R/bin/dori-secret.tmp" "$R/bin/dori-secret" || exit 1',
    "fi",
    // A starter command policy, only when the host has none: without an agent profile and a root every lane.start is
    // refused. Sandboxing is required: the `sandboxed` profile runs the agent behind the wrapper, and its `--check` runs
    // before each sandboxed start. An existing runner-config.json is the operator's and is never rewritten; what it
    // lacks for sandboxed lanes is printed instead.
    'if [ ! -e "$R/runner-config.json" ]; then',
    ...(agentCommand.length ? [
      `  A=${quote(JSON.stringify(agentCommand))}`,
      '  case "$OS" in Darwin) TR=/private/tmp ;; *) TR=/tmp ;; esac',
      `  H=$(printf '%s' "$HOME" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')`,
      // The sandboxed argv is the wrapper, then A's elements: A without its leading '['.
      '  W="$H/.dori/runner/bin/lane-sandbox"',
      `  printf '{"agents":{"default":%s,"sandboxed":["%s",%s},"allowedRoots":["%s","%s"],"sandbox":"required","sandboxCheck":["%s","--check"]}\\n' "$A" "$W" "\${A#?}" "$H" "$TR" "$W" > "$R/runner-config.json.tmp" || exit 1`,
      '  mv -f "$R/runner-config.json.tmp" "$R/runner-config.json" || exit 1',
      "  unset A H TR W",
    ] : ["  :"]),
    "else",
    "  M=",
    `  grep -Eq '"sandbox"[[:space:]]*:[[:space:]]*"required"' "$R/runner-config.json" || M="$M sandbox:required"`,
    `  grep -q '"sandboxed"' "$R/runner-config.json" || M="$M agents.sandboxed"`,
    `  grep -q '"sandboxCheck"' "$R/runner-config.json" || M="$M sandboxCheck"`,
    `  [ -z "$M" ] || printf 'RUNNER_CONFIG_SANDBOX_MISSING %s in %s; add them to sandbox lanes on this runner\\n' "\${M# }" "$R/runner-config.json"`,
    "  unset M",
    "fi",
    `cat > "$R/bin/dori.js.tmp" <<'${HEREDOC}' || exit 1`,
    `${body(bundle)}${HEREDOC}`,
    'mv -f "$R/bin/dori.js.tmp" "$R/bin/dori.js" || exit 1',
    // The `dori` a runner lane runs (its footer names this path): the bundle in lane mode.
    `printf '#!/bin/sh\\nexec "%s" "$HOME/.dori/runner/bin/dori.js" "$@"\\n' "$BUN" > "$R/bin/dori" || exit 1`,
    'chmod 700 "$R/bin/dori" || exit 1',
    'if [ "$OS" = Linux ]; then',
    `cat > "$R/dori-runner.service.tmp" <<'${HEREDOC}' || exit 1`,
    `${body(unit)}${HEREDOC}`,
    `sed -e "s|@BUN@|$BUN|g" -e "s|@PATH@|$PATH|g" "$R/dori-runner.service.tmp" > "$HOME/.config/systemd/user/dori-runner.service" || exit 1`,
    'rm -f "$R/dori-runner.service.tmp"',
    'chmod 644 "$HOME/.config/systemd/user/dori-runner.service"',
    `cat > "$R/${HERDR_UNIT}.tmp" <<'${HEREDOC}' || exit 1`,
    `${body(herdr.unit)}${HEREDOC}`,
    `sed -e "s|@HERDR_BIN@|$(esc "$HERDR")|g" -e "s|@PATH@|$(esc "$LP")|g" -e "s|@SHELL@|$(esc "$SH")|g" "$R/${HERDR_UNIT}.tmp" > "$HOME/.config/systemd/user/${HERDR_UNIT}" || exit 1`,
    `rm -f "$R/${HERDR_UNIT}.tmp"`,
    `chmod 644 "$HOME/.config/systemd/user/${HERDR_UNIT}"`,
    "else",
    `PL="$HOME/Library/LaunchAgents/${RUNNER_LAUNCHD_LABEL}.plist"`,
    `cat > "$R/${RUNNER_LAUNCHD_LABEL}.plist.tmp" <<'${HEREDOC}' || exit 1`,
    `${body(plist)}${HEREDOC}`,
    `sed -e "s|@BUN@|$BUN|g" -e "s|@PATH@|$(xesc "$(dirname "$BUN"):$LP")|g" -e "s|@HOME@|$HOME|g" "$R/${RUNNER_LAUNCHD_LABEL}.plist.tmp" > "$PL" || exit 1`,
    `rm -f "$R/${RUNNER_LAUNCHD_LABEL}.plist.tmp"`,
    'chmod 644 "$PL"',
    // launchd appends the agent's output here; created 0600 beforehand so the runner's directory check accepts it.
    ': >> "$R/runner.log" && chmod 600 "$R/runner.log" || exit 1',
    "fi",
    `C=${quote(issue.code)}`,
    `F=${quote(issue.fingerprint)}`,
    'if [ ! -f "$R/keys/supervisor.pub" ]; then',
    `  printf 'code=%s\\nfingerprint=%s\\n${issue.reply ? `reply=${issue.reply}\\n` : ""}' "$C" "$F" | "$BUN" "$R/bin/dori.js" runner serve --enroll-only --label ${quote(label)}`,
    '  E=$?',
    `  [ "$E" -ne ${INSTALL_EXIT.enrollPending} ] || exit ${INSTALL_EXIT.enrollPending}`,
    `  [ "$E" -eq 0 ] || exit ${INSTALL_EXIT.enroll}`,
    "fi",
    "unset C F",
    'if [ "$OS" = Linux ]; then',
    `loginctl enable-linger "$(id -un)" || exit ${INSTALL_EXIT.systemd}`,
    `systemctl --user daemon-reload || exit ${INSTALL_EXIT.systemd}`,
    `systemctl --user enable ${HERDR_UNIT} dori-runner.service || exit ${INSTALL_EXIT.systemd}`,
    // The unit's own herdr is left running (a changed unit file waits for herdr's next start); a herdr started by
    // hand keeps the socket, and the unit takes over once it stops; with none answering, the unit starts it.
    `if systemctl --user is-active --quiet ${HERDR_UNIT}; then HS=managed`,
    'elif [ "$HUP" = 1 ]; then HS=unmanaged',
    `else systemctl --user reset-failed ${HERDR_UNIT} >/dev/null 2>&1 || :; systemctl --user start ${HERDR_UNIT} || exit ${INSTALL_EXIT.systemd}; HS=started`,
    "fi",
    // ignore-dependencies: the runner's Wants= would otherwise start the herdr unit beside a herdr started by hand.
    `systemctl --user restart --job-mode=ignore-dependencies dori-runner.service || exit ${INSTALL_EXIT.systemd}`,
    `printf 'DORI_HERDR %s\\n' "$HS"`,
    "exit 0",
    "fi",
    // Enabled before bootstrap: an evacuated runner was disabled, and launchd refuses to bootstrap a disabled service.
    // bootout is asynchronous, so bootstrap is retried; a gui domain that refuses it falls back to the user domain.
    "boot() {",
    `  launchctl bootout "$1/${RUNNER_LAUNCHD_LABEL}" >/dev/null 2>&1 || :`,
    `  launchctl enable "$1/${RUNNER_LAUNCHD_LABEL}" || return 1`,
    "  N=1",
    '  until launchctl bootstrap "$1" "$PL"; do',
    '    [ "$N" -ge 5 ] && return 1',
    "    N=$((N + 1))",
    "    sleep 1",
    "  done",
    "}",
    'D="gui/$(id -u)"',
    `if ! { launchctl print "$D" >/dev/null 2>&1 && boot "$D"; }; then D="user/$(id -u)"; boot "$D" || exit ${INSTALL_EXIT.systemd}; fi`,
    // herdr's agent goes into the runner's domain. Loaded already: only the plist file is rewritten (no bootout, which
    // would stop herdr; launchd reads the file at the next load). A herdr started by hand: RunAtLoad false, and the
    // KeepAlive retries of a second server (it exits 1 on the taken socket) are spaced by ThrottleInterval.
    `HP="$HOME/Library/LaunchAgents/${HERDR_LAUNCHD_LABEL}.plist"`,
    `if launchctl print "$D/${HERDR_LAUNCHD_LABEL}" >/dev/null 2>&1; then HS=managed; RAL=true`,
    'elif [ "$HUP" = 1 ]; then HS=unmanaged; RAL=false',
    "else HS=started; RAL=true",
    "fi",
    `cat > "$R/${HERDR_LAUNCHD_LABEL}.plist.tmp" <<'${HEREDOC}' || exit 1`,
    `${body(herdr.plist)}${HEREDOC}`,
    `sed -e "s|@HERDR_BIN@|$(xesc "$HERDR")|g" -e "s|@PATH@|$(xesc "$LP")|g" -e "s|@SHELL@|$(xesc "$SH")|g" -e "s|@HOME@|$(xesc "$HOME")|g" -e "s|@RUN_AT_LOAD@|$RAL|g" "$R/${HERDR_LAUNCHD_LABEL}.plist.tmp" > "$HP" || exit 1`,
    `rm -f "$R/${HERDR_LAUNCHD_LABEL}.plist.tmp"`,
    'chmod 644 "$HP"',
    ': >> "$R/herdr.log" && chmod 600 "$R/herdr.log" || exit 1',
    `if [ "$HS" != managed ]; then launchctl enable "$D/${HERDR_LAUNCHD_LABEL}" || exit ${INSTALL_EXIT.systemd}; launchctl bootstrap "$D" "$HP" || exit ${INSTALL_EXIT.systemd}; fi`,
    `launchctl kickstart -k "$D/${RUNNER_LAUNCHD_LABEL}" || exit ${INSTALL_EXIT.systemd}`,
    `printf '%s\\n' "$D" > "$R/launchd-domain" || exit ${INSTALL_EXIT.systemd}`,
    `chmod 600 "$R/launchd-domain" || exit ${INSTALL_EXIT.systemd}`,
    `printf 'DORI_HERDR %s\\n' "$HS"`,
    "exit 0",
    "",
  ].join("\n");
};

/** A pinned Bun build for Windows: the release version, its zip asset and that asset's SHA-256 from the release's SHASUMS256.txt. */
export type BunPin = { readonly version: string; readonly asset: string; readonly sha256: string };

/**
 * The Bun builds a Windows runner gets, checked against these hashes on the remote host (never one fetched from the
 * same origin). `x64` needs AVX2; `baseline` is the fallback when that build does not run. Copied from
 * https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/SHASUMS256.txt when the pin changes.
 */
export const WIN_BUN = {
  x64: { version: "1.4.4", asset: "bun-windows-x64.zip", sha256: "cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5" },
  baseline: { version: "1.4.4", asset: "bun-windows-x64-baseline.zip", sha256: "0f20ce6674d4f2dbcc8c5d59fdf99f7ba45f8c3b367e0f5781cbfa30a1c78d99" },
} as const satisfies Record<string, BunPin>;

/** The release URL of a pinned asset. */
export const bunPinUrl = (pin: BunPin): string => `https://github.com/oven-sh/bun/releases/download/bun-v${pin.version}/${pin.asset}`;
/** The directory under `bun\` a pinned build is installed in: its version, with `-baseline` for the baseline build. */
export const bunPinDir = (pin: BunPin): string => (pin.asset.includes("-baseline") ? `${pin.version}-baseline` : pin.version);

const TEMPLATES = join(import.meta.dir, "..", "..", "templates");
/** The files a Windows install writes besides the bundle: the task XML, the task wrapper, the shims, the sampler and the uninstaller. */
export type WindowsTemplates = {
  readonly taskXml: string;
  readonly runnerTask: string;
  readonly ps1: string;
  readonly cmd: string;
  readonly sh: string;
  readonly sampler: string;
  readonly uninstall: string;
};
export const windowsTemplates = (): WindowsTemplates => {
  const read = (name: string): string => readFileSync(join(TEMPLATES, name), "utf8");
  return {
    taskXml: read("dori-runner-task.xml"), runnerTask: read("runner-task.ps1"), ps1: read("dori.ps1"), cmd: read("dori.cmd"),
    sh: read("dori"), sampler: read("runner-sample.ps1"), uninstall: read("uninstall.ps1"),
  };
};

/**
 * The scp command that uploads a Windows install script to `remoteName`, relative to the scp start directory (the
 * user's profile directory on Windows OpenSSH).
 */
export const scpArgv = (target: string, localFile: string, remoteName: string): string[] =>
  ["scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", localFile, `${target}:${remoteName}`];

/**
 * The PowerShell a Windows pass runs over ssh as an encoded command: it reads the uploaded script from the profile
 * directory, deletes the file before anything runs (it holds the one-time enrollment code), and runs the text as a
 * scriptblock, so the execution policy does not apply and the command line stays far under cmd.exe's limit.
 */
export const winRun = (remoteName: string): string =>
  `$ErrorActionPreference='Stop'; $f = Join-Path $env:USERPROFILE '${remoteName}'; $s = [IO.File]::ReadAllText($f); Remove-Item -LiteralPath $f -Force; & ([scriptblock]::Create($s)); exit $LASTEXITCODE`;

const psq = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const TASK = `-TaskPath '${WIN_TASK_PATH}' -TaskName '${WIN_TASK_NAME}'`;

/**
 * The PowerShell install script for a Windows worker, uploaded with scp and run from that file by `winRun`. Each step
 * appends `<ISO time> <step>` to `%USERPROFILE%\.dori\runner-install.log` as it starts, so a hang shows where it
 * stopped. It is pure ASCII: the bundle and every template travel as base64 literals written byte-exact with `[IO.File]::WriteAllBytes`, so no code
 * page, BOM or line-ending conversion can touch them. In order it:
 *
 * - refuses anything but x64 Windows 10 1809+ (exit 4) and a host without `herdr` on PATH (exit 7);
 * - creates `%USERPROFILE%\.dori\runner` with a protected DACL (the user, SYSTEM and Administrators) and the user as
 *   owner, through icacls;
 * - installs the pinned Bun into `bun\<dir>\` after checking the zip's SHA-256, and falls back to the baseline build
 *   when `bun.exe --version` fails (exit 3 when none works); bun directories other than the new and the previous one
 *   are removed;
 * - writes every file as `.tmp`, checks the bundle's full SHA-256, stops a running runner (task and recorded tree),
 *   and moves the files into `bin\`; `bin\bun.txt` names the Bun directory the shims and the wrapper use;
 * - removes the sandbox executors an older install put in `mxc\` (Windows has no lane sandbox any more);
 * - writes a starter runner-config.json (allowedRoots `%USERPROFILE%` and `%TEMP%`, `sandbox: "optional"`, only the
 *   `default` profile: Windows lanes run without a sandbox, and the lead says so at each launch) when there is none.
 *   An existing one is the operator's, except that a policy from an older install still running lanes behind the
 *   removed `dori.ps1 lane-sandbox` loses that profile and its check and becomes `sandbox: "optional"`
 *   (`RUNNER_CONFIG_UNSANDBOXED`); one that still says `sandbox: "required"` is printed
 *   (`RUNNER_CONFIG_SANDBOX_REQUIRED`), since its lanes are refused;
 * - enrolls once, skipped when `keys\supervisor.pub` exists: the code and fingerprint go to the enrolling process's
 *   stdin through a ProcessStartInfo, never its argv (exit 5 when it fails);
 * - registers and starts the `\dori\dori-runner` task (exit 6 when the Task Scheduler refuses).
 */
export const windowsInstallScript = (
  bundle: string,
  label: string,
  listenAddress: string,
  issue: EnrollIssue,
  agentCommand: readonly string[] = [],
  files: WindowsTemplates = windowsTemplates(),
  pins: readonly BunPin[] = [WIN_BUN.x64, WIN_BUN.baseline],
): string => {
  const payloads: readonly (readonly [string, string])[] = [
    ["dori.js", bundle],
    ["dori.ps1", files.ps1],
    ["dori.cmd", files.cmd],
    ["dori", files.sh],
    ["runner-task.ps1", files.runnerTask],
    ["runner-sample.ps1", files.sampler],
    ["uninstall.ps1", files.uninstall],
    ["dori-runner-task.xml", remoteUnit(files.taskXml, label, listenAddress)],
  ];
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "function Exit-Dori([int]$Code, [string]$Why) { [Console]::Error.WriteLine($Why); exit $Code }",
    "function Step([string]$N) { $L = Join-Path $env:USERPROFILE '.dori'; [void][IO.Directory]::CreateDirectory($L); [IO.File]::AppendAllText((Join-Path $L 'runner-install.log'), ([DateTime]::UtcNow.ToString('o') + ' ' + $N + [char]10), [Text.Encoding]::ASCII) }",
    "Step 'start'",
    "Step 'checks'",
    "$Arch = $env:PROCESSOR_ARCHITEW6432",
    "if (-not $Arch) { $Arch = $env:PROCESSOR_ARCHITECTURE }",
    "$Build = [Environment]::OSVersion.Version.Build",
    `if ($Arch -ne 'AMD64' -or $Build -lt 17763) { Exit-Dori ${INSTALL_EXIT.notLinux} ('unsupported Windows host: ' + $Arch + ' build ' + $Build + '; a runner needs x64 Windows 10 1809 or later') }`,
    `if (-not (Get-Command herdr -ErrorAction SilentlyContinue)) { Exit-Dori ${INSTALL_EXIT.noHerdr} 'no herdr on PATH' }`,
    "Step 'acl'",
    "$Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$R = Join-Path $env:USERPROFILE '.dori\\runner'",
    "$Bin = Join-Path $R 'bin'",
    "[void][IO.Directory]::CreateDirectory($R)",
    // Protected (no inheritance from the profile), full control for the user, SYSTEM and Administrators only; children inherit it.
    "& icacls.exe $R /inheritance:r /grant:r ('*' + $Sid + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null",
    "if ($LASTEXITCODE -ne 0) { Exit-Dori 1 'icacls could not protect the runner directory' }",
    // An elevated (administrator) ssh session creates files owned by Administrators, which the runner refuses as unsafe,
    // so the owner is set again after the files are moved in and after enrollment writes the keys.
    "function Set-DoriOwner { & icacls.exe $R /setowner ('*' + $Sid) /T /C /Q | Out-Null; if ($LASTEXITCODE -ne 0) { Exit-Dori 1 'icacls could not make the user the owner of the runner directory' } }",
    "Set-DoriOwner",
    "foreach ($D in 'bin', 'bun', 'logs', 'evidence') { [void][IO.Directory]::CreateDirectory((Join-Path $R $D)) }",
    // Bun: a pinned build, checked against the hash carried here, and run once before it is used.
    "Step 'bun'",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
    "$Pins = @(",
    pins.map((p) => `  @{ Dir = ${psq(bunPinDir(p))}; Asset = ${psq(p.asset)}; Folder = ${psq(p.asset.replace(/\.zip$/, ""))}; Url = ${psq(bunPinUrl(p))}; Sha256 = ${psq(p.sha256)} }`).join(",\n"),
    ")",
    "function Get-DoriBun($Pin) {",
    "  $Exe = Join-Path $R ('bun\\' + $Pin.Dir + '\\bun.exe')",
    "  if (Test-Path -LiteralPath $Exe) { return $Exe }",
    "  $T = Join-Path $R ('bun\\download-' + [Guid]::NewGuid().ToString('N'))",
    "  try {",
    "    [void][IO.Directory]::CreateDirectory($T)",
    "    $Zip = Join-Path $T $Pin.Asset",
    "    Invoke-WebRequest -UseBasicParsing -Uri $Pin.Url -OutFile $Zip",
    "    $Got = (Get-FileHash -Algorithm SHA256 -LiteralPath $Zip).Hash.ToLowerInvariant()",
    "    if ($Got -ne $Pin.Sha256) { throw ('bun checksum mismatch for ' + $Pin.Asset + ': ' + $Got) }",
    "    Expand-Archive -LiteralPath $Zip -DestinationPath $T -Force",
    "    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Exe))",
    "    Move-Item -LiteralPath (Join-Path (Join-Path $T $Pin.Folder) 'bun.exe') -Destination $Exe -Force",
    "    return $Exe",
    "  } catch { [Console]::Error.WriteLine($_.Exception.Message); return $null }",
    "  finally { Remove-Item -LiteralPath $T -Recurse -Force -ErrorAction SilentlyContinue }",
    "}",
    "function Test-DoriBun([string]$Exe) {",
    "  $ErrorActionPreference = 'Continue'",
    "  try { & $Exe --version | Out-Null; return ($LASTEXITCODE -eq 0) } catch { return $false }",
    "}",
    "$BunDir = $null",
    "foreach ($Pin in $Pins) {",
    "  $Exe = Get-DoriBun $Pin",
    "  if ($Exe -and (Test-DoriBun $Exe)) { $BunDir = $Pin.Dir; break }",
    "}",
    `if (-not $BunDir) { Exit-Dori ${INSTALL_EXIT.noBun} 'no usable bun: the pinned bun-windows-x64 builds could not be downloaded, verified or run' }`,
    "$Bun = Join-Path $R ('bun\\' + $BunDir + '\\bun.exe')",
    // An older install's lane sandbox executors: nothing runs them any more.
    "$OldSandbox = Join-Path $R 'mxc'",
    "if (Test-Path -LiteralPath $OldSandbox) { Remove-Item -LiteralPath $OldSandbox -Recurse -Force -ErrorAction SilentlyContinue }",
    // Every file is written beside its target first; the bundle's hash is checked before anything is replaced.
    "Step 'files'",
    "function Write-DoriFile([string]$Name, [string]$Data) { [IO.File]::WriteAllBytes((Join-Path $Bin ($Name + '.tmp')), [Convert]::FromBase64String($Data)) }",
    ...payloads.map(([name, text]) => `Write-DoriFile ${psq(name)} '${b64(text)}'`),
    `if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Bin 'dori.js.tmp')).Hash.ToLowerInvariant() -ne '${sha256(bundle)}') { Exit-Dori 1 'dori.js does not match its SHA-256 after writing' }`,
    // A running runner is stopped before its files are replaced: the task first, so its wrapper does not start it again.
    "Step 'stop-runner'",
    `if (Get-ScheduledTask ${TASK} -ErrorAction SilentlyContinue) { Stop-ScheduledTask ${TASK} }`,
    WIN_KILL_RUNNER,
    "Step 'move'",
    "function Move-DoriFile([string]$Name) {",
    "  $To = Join-Path $Bin $Name",
    "  for ($N = 1; ; $N++) {",
    "    try { Move-Item -LiteralPath ($To + '.tmp') -Destination $To -Force; return }",
    "    catch { if ($N -ge 10) { throw }; Start-Sleep -Milliseconds 500 }",
    "  }",
    "}",
    ...payloads.map(([name]) => `Move-DoriFile ${psq(name)}`),
    // The previous bun stays until the next install (the runner using it may not have said hello on the new one yet).
    "$BunTxt = Join-Path $Bin 'bun.txt'",
    "$Prev = ''",
    "if (Test-Path -LiteralPath $BunTxt) { $Prev = ([IO.File]::ReadAllText($BunTxt)).Trim() }",
    "Get-ChildItem -LiteralPath (Join-Path $R 'bun') -Directory | Where-Object { $_.Name -ne $BunDir -and $_.Name -ne $Prev } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }",
    "[IO.File]::WriteAllText($BunTxt, $BunDir)",
    // A starter command policy, only when the host has none; an existing runner-config.json is the operator's.
    "Step 'config'",
    // Windows has no lane sandbox: lanes run unsandboxed under the `default` profile, which needs `sandbox: "optional"`.
    ...(agentCommand.length ? [
      "$Cfg = Join-Path $R 'runner-config.json'",
      "if (-not (Test-Path -LiteralPath $Cfg)) {",
      `  $Agent = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(JSON.stringify(agentCommand))}'))`,
      `  $Json = '{"agents":{"default":' + $Agent + '},"allowedRoots":[' + (ConvertTo-Json $env:USERPROFILE) + ',' + (ConvertTo-Json $env:TEMP) + '],"sandbox":"optional"}'`,
      "  [IO.File]::WriteAllText($Cfg + '.tmp', $Json + [char]10)",
      "  Move-Item -LiteralPath ($Cfg + '.tmp') -Destination $Cfg -Force",
      "} else {",
      "  $Have = [IO.File]::ReadAllText($Cfg)",
      // An older install's policy runs sandboxed lanes behind the removed `dori.ps1 lane-sandbox`: that profile and its
      // check go, and the lanes run unsandboxed; everything else in the file is kept.
      "  if ($Have -match '\"lane-sandbox\"') {",
      "    try {",
      "      $O = $Have | ConvertFrom-Json",
      "      if ($O.agents) { $O.agents.PSObject.Properties.Remove('sandboxed') }",
      "      $O.PSObject.Properties.Remove('sandboxCheck')",
      "      $O | Add-Member -NotePropertyName sandbox -NotePropertyValue 'optional' -Force",
      "      [IO.File]::WriteAllText($Cfg + '.tmp', ($O | ConvertTo-Json -Depth 20 -Compress) + [char]10)",
      "      Move-Item -LiteralPath ($Cfg + '.tmp') -Destination $Cfg -Force",
      "      Write-Output ('RUNNER_CONFIG_UNSANDBOXED ' + $Cfg + ': dropped the lane-sandbox profile and sandboxCheck, sandbox is optional')",
      "    } catch { Write-Output ('RUNNER_CONFIG_SANDBOX_REQUIRED ' + $Cfg + ' could not be rewritten (' + $_.Exception.Message + '); remove agents.sandboxed and sandboxCheck and set \"sandbox\": \"optional\": Windows lanes run without a sandbox') }",
      "  } elseif ($Have -match '\"sandbox\"\\s*:\\s*\"required\"') {",
      "    Write-Output ('RUNNER_CONFIG_SANDBOX_REQUIRED ' + $Cfg + ' says \"sandbox\": \"required\"; set it to \"optional\": Windows lanes run without a sandbox, so this runner refuses them')",
      "  }",
      "}",
    ] : []),
    "Set-DoriOwner",
    "Step 'enroll'",
    `$C = ${psq(issue.code)}`,
    `$F = ${psq(issue.fingerprint)}`,
    "if (-not (Test-Path -LiteralPath (Join-Path $R 'keys\\supervisor.pub'))) {",
    "  $Psi = New-Object System.Diagnostics.ProcessStartInfo",
    "  $Psi.FileName = $Bun",
    `  $Psi.Arguments = '"' + (Join-Path $Bin 'dori.js') + '" runner serve --enroll-only --label ' + ${psq(label)}`,
    "  $Psi.UseShellExecute = $false",
    "  $Psi.RedirectStandardInput = $true",
    "  $Psi.WorkingDirectory = $R",
    "  $Enroll = [System.Diagnostics.Process]::Start($Psi)",
    "  $Enroll.StandardInput.Write('code=' + $C + [char]10 + 'fingerprint=' + $F + [char]10)",
    ...(issue.reply ? [`  $Enroll.StandardInput.Write('reply=${issue.reply}' + [char]10)`] : []),
    "  $Enroll.StandardInput.Close()",
    "  $Enroll.WaitForExit()",
    `  if ($Enroll.ExitCode -eq ${INSTALL_EXIT.enrollPending}) { exit ${INSTALL_EXIT.enrollPending} }`,
    `  if ($Enroll.ExitCode -ne 0) { Exit-Dori ${INSTALL_EXIT.enroll} ('enrollment failed with exit ' + $Enroll.ExitCode) }`,
    "}",
    "Remove-Variable C, F",
    "Set-DoriOwner",
    "Step 'task'",
    "try {",
    "  $Xml = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes((Join-Path $Bin 'dori-runner-task.xml'))).Replace('@RUNNER@', [Security.SecurityElement]::Escape($R)).Replace('@USER@', $Sid)",
    `  Register-ScheduledTask ${TASK} -Xml $Xml -Force | Out-Null`,
    `  Enable-ScheduledTask ${TASK} | Out-Null`,
    `  Start-ScheduledTask ${TASK}`,
    `} catch { Exit-Dori ${INSTALL_EXIT.systemd} ('task scheduler: ' + $_.Exception.Message) }`,
    "Step 'done'",
    "Write-Output ('DORI_BUN ' + $BunDir)",
    "exit 0",
    "",
  ];
  return lines.join("\n");
};

const NOT_POSIX = /not recognized|is not recognized as|CommandNotFoundException/i;

type InstallKind = "posix" | "windows";

const installResult = (kind: InstallKind, r: Ran, bundle: string): InstallResult => {
  // PowerShell over a non-tty ssh appends its progress stream to stderr as CLIXML, which hides the real error line.
  const detail = r.err.trim().split("\n").filter((line) => !/^(#< CLIXML|<Objs )/.test(line.trim())).at(-1) || `exit ${r.code}`;
  const windows = kind === "windows";
  if (r.code === 0) {
    const herdr = [...r.out.matchAll(/^DORI_HERDR (started|managed|unmanaged)$/gm)].at(-1)?.[1] as HerdrInstall | undefined;
    return { ok: true, version: bundleVersion(bundle), ...(herdr ? { herdr } : {}) };
  }
  if (r.timedOut || r.code === RUN_TIMEOUT_CODE || r.code === 255) {
    return { ok: false, code: "RUNNER_INSTALL_UNREACHABLE", detail: windows ? `${detail} (progress: %USERPROFILE%\\.dori\\runner-install.log on the host)` : detail };
  }
  if (windows && r.code === INSTALL_EXIT.notLinux) return { ok: false, code: "RUNNER_INSTALL_UNSUPPORTED", detail: `unsupported OS: a Windows runner needs x64 Windows 10 1809 or later (${detail})` };
  if (!windows && (r.code === INSTALL_EXIT.notLinux || NOT_POSIX.test(r.err))) return { ok: false, code: "RUNNER_INSTALL_UNSUPPORTED", detail: `unsupported OS: only Linux and macOS machines take a runner (${detail})` };
  if (r.code === INSTALL_EXIT.noBun) {
    return { ok: false, code: "RUNNER_INSTALL_NO_BUN", detail: windows ? `no usable bun: the pinned Windows build could not be downloaded, verified or run (${detail})` : "no usable bun on the remote host (Linux needs it on PATH; on macOS it could not be found or downloaded)" };
  }
  if (r.code === INSTALL_EXIT.noHerdr) return { ok: false, code: "RUNNER_INSTALL_NO_HERDR", detail: windows ? "no herdr on the remote host's PATH: install herdr (https://herdr.dev) there first" : "no herdr on the remote host's login PATH: install herdr (https://herdr.dev) there first" };
  if (r.code === INSTALL_EXIT.enroll) return { ok: false, code: "RUNNER_INSTALL_ENROLL_FAILED", detail };
  return { ok: false, code: "RUNNER_INSTALL_FAILED", detail: r.code === INSTALL_EXIT.systemd ? `${windows ? "task scheduler" : "service manager"}: ${detail}` : detail };
};

export const installRunner = async (deps: InstallDeps, req: InstallRequest): Promise<InstallResult> => {
  if (!LABEL.test(req.label)) return { ok: false, code: "RUNNER_INSTALL_FAILED", detail: `bad label ${req.label}` };
  if (!isPrivateListen(req.listenAddress)) return { ok: false, code: "RUNNER_LISTEN_REFUSED", detail: `${req.listenAddress} is not a private host:port` };
  const step = stepper(deps.progress, req.label);
  step("connect", "start", req.machine.target);
  const k = await (deps.kind ?? machineKind)(deps.run, req.machine);
  if (!k.ok) {
    const code = k.unsupported ? "RUNNER_INSTALL_UNSUPPORTED" : "RUNNER_INSTALL_UNREACHABLE";
    step("connect", "failed", `${code} ${k.detail}`);
    return { ok: false, code, detail: k.detail };
  }
  step("connect", "done", k.kind);
  step("upload", "start", "bundling the runner");
  let bundle: string;
  try {
    bundle = await deps.bundle();
  } catch (error) {
    step("upload", "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
  step("upload", "done", `bundle ${bundleVersion(bundle)}; ${k.kind === "windows" ? "each install pass copies its script over scp" : "each install pass sends it over ssh stdin"}`);
  const unit = remoteUnit(deps.unitTemplate ?? readFileSync(RUNNER_REMOTE_UNIT_TEMPLATE, "utf8"), req.label, req.listenAddress);
  const plist = remoteUnit(deps.plistTemplate ?? readFileSync(RUNNER_LAUNCHD_PLIST_TEMPLATE, "utf8"), req.label, req.listenAddress);
  const issue = req.issue();
  if (!ENROLL_VALUE.test(issue.code) || !ENROLL_VALUE.test(issue.fingerprint)) return { ok: false, code: "RUNNER_INSTALL_FAILED", detail: "bad enrollment code or fingerprint" };
  let kind: InstallKind = k.kind;
  const target = req.machine.target;
  // A Windows pass: scp uploads the script to the profile directory, then ssh runs it from there with an empty stdin.
  // An scp failure is returned as the install's result and the ssh step is skipped.
  const installWindows = async (script: string): Promise<Ran | InstallResult> => {
    // The state dir, not /tmp: the script embeds the bundle, and a supervisor host's /tmp may be a small, quota'd tmpfs.
    const dir = mkdtempSync(join(req.stateDir, "runner-install-"));
    try {
      const local = join(dir, "install.ps1");
      writeFileSync(local, script, { mode: 0o600 });
      const remoteName = `.dori-runner-install-${randomBytes(8).toString("hex")}.ps1`;
      const up = await deps.run(scpArgv(target, local, remoteName), { timeoutMs: INSTALL_TIMEOUT_MS });
      if (up.code !== 0) {
        const detail = `scp: ${(up.err.trim().split("\n").at(-1) ?? "") || `exit ${up.code}`}`;
        const unreachable = up.timedOut || up.code === RUN_TIMEOUT_CODE || up.code === 255;
        return { ok: false, code: unreachable ? "RUNNER_INSTALL_UNREACHABLE" : "RUNNER_INSTALL_FAILED", detail };
      }
      return await deps.run(sshArgv(target, encodedPowerShell(winRun(remoteName))), { timeoutMs: WIN_INSTALL_TIMEOUT_MS });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const install = (enrollment: EnrollIssue): Promise<Ran | InstallResult> => {
    if (kind === "windows") return installWindows(windowsInstallScript(bundle, req.label, req.listenAddress, enrollment, req.agentCommand, deps.windowsTemplates ?? windowsTemplates()));
    const script = installScript(bundle, unit, req.label, req.listenAddress, enrollment, plist, req.agentCommand, deps.herdrTemplates, deps.laneSandbox, deps.laneSandboxMacos);
    return deps.run(sshArgv(target, "sh -s"), { stdin: script, timeoutMs: INSTALL_TIMEOUT_MS });
  };
  const failed = (result: InstallResult): InstallResult => {
    if (!result.ok) step("install", "failed", `${result.code} ${result.detail}`);
    return result;
  };
  step("install", "start", "files, bun, enrollment and service registration in one remote pass");
  let pass = await install(issue);
  if ("ok" in pass) return failed(pass);
  let r = pass;
  // A POSIX shell on Windows: powershell.exe is reachable from it, so the Windows install runs instead.
  if (kind === "posix" && r.code === INSTALL_EXIT.windowsShell) {
    kind = "windows";
    step("install", "start", "again as a Windows install (the ssh shell is a POSIX shell on Windows)");
    pass = await install(issue);
    if ("ok" in pass) return failed(pass);
    r = pass;
  }
  if (r.code === INSTALL_EXIT.enrollPending) {
    step("enroll", "start", "the host sent an enrollment request");
    try {
      const line = /^RUNNER_ENROLL_REQUEST (.+)$/m.exec(r.out)?.[1];
      if (!line) throw new Error("missing enrollment request on SSH stdout");
      const frame = decodeFrame(line, "runner");
      if (frame.type !== "enroll" || frame.runner !== req.label) throw new Error("unexpected enrollment request");
      const body = frame.body as RunnerControlBodies["enroll"];
      if (body.label !== req.label) throw new Error("enrollment request label differs from install label");
      const accepted = req.enroll(body);
      if (!accepted.ok) throw new Error(`${accepted.code} ${accepted.detail}`);
      const reply = Buffer.from(encodeFrame(supervisorControl({ runner: req.label, gen: 0, epoch: 0 }, "enroll.ok", accepted.reply))).toString("base64");
      step("enroll", "done", "accepted");
      step("install", "start", "again with the supervisor's enrollment reply");
      pass = await install({ ...issue, reply });
      if ("ok" in pass) return failed(pass);
      r = pass;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      step("enroll", "failed", detail);
      return { ok: false, code: "RUNNER_INSTALL_ENROLL_FAILED", detail };
    }
  }
  const result = installResult(kind, r, bundle);
  if (!result.ok) {
    // Exit `systemd` is the script's service-manager stage, so everything before it went through.
    if (r.code !== INSTALL_EXIT.systemd) return failed(result);
    step("install", "done");
    step("service", "failed", `${result.code} ${result.detail}`);
    return result;
  }
  step("install", "done");
  step("service", "done", kind === "windows" ? "scheduled task registered and started" : `runner service registered and started; ${herdrInstallNote(result.herdr)}`);
  if (kind === "windows") {
    // Windows has no lane sandbox; a policy that still requires one refuses this host's lanes (the install went through).
    const refused = [...r.out.matchAll(/^RUNNER_CONFIG_SANDBOX_REQUIRED .*$/gm)].map((m) => m[0].trim());
    const migrated = [...r.out.matchAll(/^RUNNER_CONFIG_UNSANDBOXED .*$/gm)].map((m) => m[0].trim());
    step("sandbox", refused.length ? "failed" : "done", [...refused, ...migrated, "none: Windows has no lane sandbox, so lanes here run unsandboxed (SANDBOX_SKIPPED at each launch)"].join("; "));
  }
  step("verify", "start");
  writeRunnerEndpoint(req.stateDir, req.label, req.listenAddress);
  step("verify", "done", `remote pass exited 0, version=${result.version}, endpoint ${req.listenAddress} recorded`);
  return result;
};

/**
 * Bundles the CLI for a remote runner. The bundle has no git checkout on the remote host, so the source's short SHA is
 * baked in as `DORI_RUNNER_VERSION` (version.ts), which the runner reports in its hello. The bundle is written under
 * `scratchRoot` (the supervisor passes its state dir): /tmp on a supervisor host may be a quota'd tmpfs that is full.
 */
export const buildBundle = (run: Runner, entry: string = RUNNER_CLI_ENTRY, scratchRoot: string = tmpdir()) => async (): Promise<string> => {
  const dir = mkdtempSync(join(scratchRoot, "dori-runner-bundle-"));
  try {
    const out = join(dir, "dori.js");
    const version = await gitVersion(run, import.meta.dir);
    const define = version ? ["--define", `${RUNNER_VERSION_DEFINE}=${JSON.stringify(version)}`] : [];
    const r = await run(["bun", "build", entry, "--target=bun", ...define, "--outfile", out], { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`RUNNER_BUNDLE_FAILED ${r.err.trim().split("\n").at(-1) ?? `exit ${r.code}`}`);
    return readFileSync(out, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
