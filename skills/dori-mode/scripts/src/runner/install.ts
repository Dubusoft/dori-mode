import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshArgv, type GuardMachine } from "../remote-guard.ts";
import { RUN_TIMEOUT_CODE, type Runner } from "../run.ts";
import { gitVersion, RUNNER_VERSION_DEFINE } from "./version.ts";

/**
 * Installs or upgrades the runner on a remote Linux or macOS machine over ssh, as design 3.2 and 5.4 lay out. The ssh
 * command line is always the fixed `sh -s`; the whole install - the CLI bundle, the systemd unit, the launchd plist,
 * the one-time enrollment code and the supervisor key fingerprint - travels on ssh's stdin as one POSIX sh script
 * that branches on `uname -s`. The code and fingerprint
 * are shell variables inside that script and reach the enrolling process through a pipe from the `printf` builtin,
 * so they never appear in any process's argv on either machine.
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
 * manager (systemd, linger or launchd) failed; 7 no `herdr` on the login PATH; anything else is a generic failure.
 * ssh's own 255 or a timeout is unreachable.
 */

export const RUNNER_REMOTE_UNIT_TEMPLATE = join(import.meta.dir, "..", "..", "templates", "dori-runner-remote.service");
export const RUNNER_LAUNCHD_PLIST_TEMPLATE = join(import.meta.dir, "..", "..", "templates", "dori-runner-launchd.plist");
export const RUNNER_LAUNCHD_LABEL = "com.dori.runner";
export const HERDR_REMOTE_UNIT_TEMPLATE = join(import.meta.dir, "..", "..", "templates", "herdr-runner-remote.service");
export const HERDR_LAUNCHD_PLIST_TEMPLATE = join(import.meta.dir, "..", "..", "templates", "dori-herdr-launchd.plist");
export const HERDR_LAUNCHD_LABEL = "com.dori.herdr";
export const HERDR_UNIT = "herdr-server.service";
export const RUNNER_CLI_ENTRY = join(import.meta.dir, "bin.ts");
export const INSTALL_TIMEOUT_MS = 180_000;
const HEREDOC = "DORI_RUNNER_EOF";
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONNECT = /^ws:\/\/[A-Za-z0-9.:[\]-]+:\d{1,5}$/;
const ENROLL_VALUE = /^[A-Za-z0-9_:=+/.-]+$/;

export const INSTALL_EXIT = { noBun: 3, notLinux: 4, enroll: 5, systemd: 6, noHerdr: 7 } as const;

export type InstallFailure =
  | "RUNNER_INSTALL_UNREACHABLE"
  | "RUNNER_INSTALL_UNSUPPORTED"
  | "RUNNER_INSTALL_NO_BUN"
  | "RUNNER_INSTALL_NO_HERDR"
  | "RUNNER_INSTALL_ENROLL_FAILED"
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

export type EnrollIssue = { readonly code: string; readonly fingerprint: string };

export type InstallDeps = {
  readonly run: Runner;
  readonly bundle: () => Promise<string>;
  /** The remote unit template text; defaults to templates/dori-runner-remote.service. */
  readonly unitTemplate?: string;
  /** The remote launchd plist template text; defaults to templates/dori-runner-launchd.plist. */
  readonly plistTemplate?: string;
  /** The herdr unit and plist texts; default to templates/herdr-runner-remote.service and templates/dori-herdr-launchd.plist. */
  readonly herdrTemplates?: HerdrTemplates;
};

export type InstallRequest = {
  readonly machine: GuardMachine;
  readonly label: string;
  /** `ws://<host>:<port>` of the supervisor's `runners.listen`. */
  readonly connectUrl: string;
  /** Issues the one-time enrollment code; called only after every input checked out. */
  readonly issue: () => EnrollIssue;
  /** The lead's agent command: the `default` profile of the starter runner-config.json the script writes when there is none. */
  readonly agentCommand: readonly string[];
};

export const bundleVersion = (bundle: string): string => createHash("sha256").update(bundle).digest("hex").slice(0, 12);

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The unit text for `label` and `connectUrl`; `@BUN@` and `@PATH@` are filled on the remote host by the script. The
 * template uses `@NAME@` markers rather than setup's `{{NAME}}`, because setup does not render it.
 */
export const remoteUnit = (template: string, label: string, connectUrl: string): string =>
  template.replaceAll("@LABEL@", label).replaceAll("@CONNECT@", connectUrl);

const BUN_RELEASE = "https://github.com/oven-sh/bun/releases/latest/download";

export const installScript = (
  bundle: string,
  unit: string,
  label: string,
  connectUrl: string,
  issue: EnrollIssue,
  plist: string = remoteUnit(readFileSync(RUNNER_LAUNCHD_PLIST_TEMPLATE, "utf8"), label, connectUrl),
  agentCommand: readonly string[] = [],
  herdr: HerdrTemplates = herdrTemplates(),
): string => {
  for (const text of [bundle, unit, plist, herdr.unit, herdr.plist]) {
    if (text.split("\n").some((line) => line.replace(/\r$/, "") === HEREDOC)) throw new Error(`install payload contains the heredoc delimiter ${HEREDOC}`);
  }
  const body = (text: string): string => (text.endsWith("\n") ? text : `${text}\n`);
  return [
    "set -u",
    "umask 077",
    "OS=$(uname -s)",
    `case "$OS" in Linux|Darwin) ;; *) exit ${INSTALL_EXIT.notLinux} ;; esac`,
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
    // A starter command policy, only when the host has none: without an agent profile and a root every lane.start is
    // refused. An existing runner-config.json is the operator's and is never rewritten.
    ...(agentCommand.length ? [
      'if [ ! -e "$R/runner-config.json" ]; then',
      `  A=${quote(JSON.stringify(agentCommand))}`,
      '  case "$OS" in Darwin) TR=/private/tmp ;; *) TR=/tmp ;; esac',
      `  H=$(printf '%s' "$HOME" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')`,
      `  printf '{"agents":{"default":%s},"allowedRoots":["%s","%s"]}\\n' "$A" "$H" "$TR" > "$R/runner-config.json.tmp" && mv -f "$R/runner-config.json.tmp" "$R/runner-config.json" || exit 1`,
      "  unset A H TR",
      "fi",
    ] : []),
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
    `sed -e "s|@BUN@|$BUN|g" -e "s|@PATH@|$(dirname "$BUN"):$PATH|g" -e "s|@HOME@|$HOME|g" "$R/${RUNNER_LAUNCHD_LABEL}.plist.tmp" > "$PL" || exit 1`,
    `rm -f "$R/${RUNNER_LAUNCHD_LABEL}.plist.tmp"`,
    'chmod 644 "$PL"',
    // launchd appends the agent's output here; created 0600 beforehand so the runner's directory check accepts it.
    ': >> "$R/runner.log" && chmod 600 "$R/runner.log" || exit 1',
    "fi",
    `C=${quote(issue.code)}`,
    `F=${quote(issue.fingerprint)}`,
    'if [ ! -f "$R/keys/supervisor.pub" ]; then',
    `  printf 'code=%s\\nfingerprint=%s\\n' "$C" "$F" | "$BUN" "$R/bin/dori.js" runner serve --enroll-only --label ${quote(label)} --connect ${quote(connectUrl)} || exit ${INSTALL_EXIT.enroll}`,
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

const NOT_POSIX = /not recognized|is not recognized as|CommandNotFoundException/i;

export const installRunner = async (deps: InstallDeps, req: InstallRequest): Promise<InstallResult> => {
  if (!LABEL.test(req.label)) return { ok: false, code: "RUNNER_INSTALL_FAILED", detail: `bad label ${req.label}` };
  if (!CONNECT.test(req.connectUrl)) return { ok: false, code: "RUNNER_INSTALL_FAILED", detail: `bad connect url ${req.connectUrl}` };
  const bundle = await deps.bundle();
  const unit = remoteUnit(deps.unitTemplate ?? readFileSync(RUNNER_REMOTE_UNIT_TEMPLATE, "utf8"), req.label, req.connectUrl);
  const plist = remoteUnit(deps.plistTemplate ?? readFileSync(RUNNER_LAUNCHD_PLIST_TEMPLATE, "utf8"), req.label, req.connectUrl);
  const issue = req.issue();
  if (!ENROLL_VALUE.test(issue.code) || !ENROLL_VALUE.test(issue.fingerprint)) return { ok: false, code: "RUNNER_INSTALL_FAILED", detail: "bad enrollment code or fingerprint" };
  const script = installScript(bundle, unit, req.label, req.connectUrl, issue, plist, req.agentCommand, deps.herdrTemplates);
  const r = await deps.run(sshArgv(req.machine.target, "sh -s"), { stdin: script, timeoutMs: INSTALL_TIMEOUT_MS });
  const detail = (r.err.trim().split("\n").at(-1) ?? "") || `exit ${r.code}`;
  if (r.code === 0) {
    const herdr = [...r.out.matchAll(/^DORI_HERDR (started|managed|unmanaged)$/gm)].at(-1)?.[1] as HerdrInstall | undefined;
    return { ok: true, version: bundleVersion(bundle), ...(herdr ? { herdr } : {}) };
  }
  if (r.timedOut || r.code === RUN_TIMEOUT_CODE || r.code === 255) return { ok: false, code: "RUNNER_INSTALL_UNREACHABLE", detail };
  if (r.code === INSTALL_EXIT.notLinux || NOT_POSIX.test(r.err)) return { ok: false, code: "RUNNER_INSTALL_UNSUPPORTED", detail: `unsupported OS: only Linux and macOS machines take a runner (${detail})` };
  if (r.code === INSTALL_EXIT.noBun) return { ok: false, code: "RUNNER_INSTALL_NO_BUN", detail: "no usable bun on the remote host (Linux needs it on PATH; on macOS it could not be found or downloaded)" };
  if (r.code === INSTALL_EXIT.noHerdr) return { ok: false, code: "RUNNER_INSTALL_NO_HERDR", detail: "no herdr on the remote host's login PATH: install herdr (https://herdr.dev) there first" };
  if (r.code === INSTALL_EXIT.enroll) return { ok: false, code: "RUNNER_INSTALL_ENROLL_FAILED", detail };
  return { ok: false, code: "RUNNER_INSTALL_FAILED", detail: r.code === INSTALL_EXIT.systemd ? `service manager: ${detail}` : detail };
};

/**
 * Bundles the CLI for a remote runner. The bundle has no git checkout on the remote host, so the source's short SHA is
 * baked in as `DORI_RUNNER_VERSION` (version.ts), which the runner reports in its hello.
 */
export const buildBundle = (run: Runner, entry: string = RUNNER_CLI_ENTRY) => async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "dori-runner-bundle-"));
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
