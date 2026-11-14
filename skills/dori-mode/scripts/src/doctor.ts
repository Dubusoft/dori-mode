import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { alertsChannelOf, CONFIG_FILE_KEYS, configPath, defaultConfig, loadConfig, type DoriConfig } from "./config.ts";
import { gatewayView, readGatewayStatus } from "./gateway-status.ts";
import { githubSummary } from "./github-events.ts";
import { pendingLeadRestart } from "./lead-restart.ts";
import { wakeSource } from "./lead-wakes.ts";
import { readWakes } from "./store.ts";
import { legacyPaneKeys, managedPanesPath } from "./managed-panes.ts";
import { MEMORY_FILE, resolveMemoryRepo } from "./memory-check.ts";
import { fetchHttp, type Http } from "./messenger/http.ts";
import { listPanes } from "./panes.ts";
import type { RecoveryLane } from "./recover.ts";
import { Registry, statusOf } from "./registry.ts";
import { type Clock, realClock, type Runner, run } from "./run.ts";
import { LEGACY_PRESENCE, SERVICES, unitState } from "./status.ts";
import { openOperations } from "./operations.ts";
import { checkRunnerDir, defaultRunnerDir, RUNNER_PATHS } from "./runner/fs-safety.ts";
import { HERDR_ELEVATED_FIX, herdrUnitInstalled } from "./runner/herdr-watch.ts";
import { LOCAL_RUNNER } from "./runner/serve.ts";
import { readRunnerRows } from "./runner/hub.ts";
import { readRunnerEndpoints } from "./runner/endpoints.ts";
import { RESTART_CIRCUIT_MAX, RESTART_CIRCUIT_WINDOW_MS } from "./runner/liveness.ts";
import { OUTBOX_LARGE_AGE_MS, OUTBOX_LARGE_ROWS } from "./runner/outbox.ts";
import { LABEL_PATTERN, PROTO } from "./runner/protocol.ts";
import { CREDENTIAL_DENY, installedLaneSandbox, LANE_SANDBOX_MACOS_TEMPLATE, LANE_SANDBOX_TEMPLATE, laneSandboxScript } from "./lane-sandbox-install.ts";
import { isWindowsOs, unsandboxedReason } from "./runner-sandbox.ts";
import { LEGACY_GUARD_AGENT_FILES, legacyGuardAgentFiles } from "./runner/legacy-guard.ts";
import { SecretStore, SecretStoreError, type SecretEntry } from "./secret-store.ts";

export type Level = "OK" | "WARN" | "FAIL";
export type Check = { readonly id: string; readonly level: Level; readonly detail: string; readonly fix?: string };

export type DoctorDeps = {
  readonly run: Runner;
  readonly http: Http;
  readonly clock: Clock;
  readonly config: DoriConfig;
  readonly configPath: string;
  readonly configError?: string;
  readonly envPath: string;
  readonly token?: string;
  readonly tokenSource?: "file" | "env";
  readonly exists: (path: string) => boolean;
  /** Where omo memory is looked for when memoryCheck.repo is blank. */
  readonly home: string;
  /** Test seams for the sandbox check: the host platform (default process.platform) and the PATH lookup (default Bun.which). */
  readonly platform?: string;
  readonly which?: (cmd: string) => string | null | undefined;
  /** Test seam for the config source report: the environment loadConfig read (default process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seams for the secret store check: the store (default one under `home`) and the permission-bits lookup (default fs.statSync). */
  readonly secretStore?: Pick<SecretStore, "dir" | "list" | "encryptionAvailable">;
  readonly modeOf?: (path: string) => number | undefined;
};

const ok = (id: string, detail: string): Check => ({ id, level: "OK", detail });
const warn = (id: string, detail: string, fix: string): Check => ({ id, level: "WARN", detail, fix });
const fail = (id: string, detail: string, fix: string): Check => ({ id, level: "FAIL", detail, fix });

const T = { timeoutMs: 5_000 };
const API = "https://discord.com/api/v10";
const MESSAGE_CONTENT = 1 << 18;
const MESSAGE_CONTENT_LIMITED = 1 << 19;
const RESTART = "systemctl --user restart dori-supervisor.service";
const LEAD_WAKE_WARNING_THRESHOLD = 20;

export const tokenFrom = (envText: string | undefined): string | undefined => {
  const m = /^\s*(?:export\s+)?DORI_DISCORD_TOKEN=(.*)$/m.exec(envText ?? "");
  const v = m?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  return v || undefined;
};

const units = async (d: DoctorDeps): Promise<Check[]> => {
  const checks: Check[] = [];
  const [herdrUnit, supUnit] = await Promise.all(SERVICES.map((name) => unitState(d.run, name)));
  const [legacy, procs] = await Promise.all([unitState(d.run, LEGACY_PRESENCE), d.run(["pgrep", "-f", "(dori|cli\\.ts) presence"], T)]);
  for (const u of [herdrUnit, supUnit]) {
    if (!u) continue;
    const id = `unit ${u.name.replace(/\.service$/, "")}`;
    if (u.enabled === "enabled" && u.active === "active") checks.push(ok(id, "enabled, active"));
    else if (u.enabled === "not-found" || u.active === "unknown") checks.push(fail(id, `not installed (${u.enabled}/${u.active})`, "dori setup --autostart"));
    else checks.push(fail(id, `${u.enabled}, ${u.active}`, `systemctl --user enable --now ${u.name}`));
  }
  const runnerUnit = await unitState(d.run, "dori-runner.service");
  if (runnerUnit.enabled === "enabled") checks.push(warn("runner unit", "dori-runner.service is enabled; the supervisor runs the local runner itself", "systemctl --user disable --now dori-runner.service"));
  const pids = procs.code === 0 ? procs.out.split("\n").filter(Boolean) : [];
  const unitOn = legacy.enabled === "enabled" || ["active", "activating"].includes(legacy.active);
  if (unitOn) checks.push(warn("legacy presence", `${LEGACY_PRESENCE} is ${legacy.enabled}/${legacy.active}; two gateways risk double replies`, `systemctl --user disable --now ${LEGACY_PRESENCE}`));
  else if (pids.length) checks.push(warn("legacy presence", `stray 'dori presence' process (pid ${pids.join(", ")})`, `kill ${pids.join(" ")}`));
  else checks.push(ok("legacy presence", "none running"));
  return checks;
};

/**
 * Lanes on a Linux host run inside bwrap and on a macOS host inside Seatbelt (sandbox-exec), via the installed
 * lane-sandbox wrapper, so a missing wrapper, a missing bwrap or a wrapper whose --check fails is a FAIL (lanes there are
 * refused, not run bare). Windows has no lane sandbox: its lanes run without one by design, a WARN so it stays in view.
 * Other platforms have no wrapper: lanes there need runners.<label>.allowUnsandboxed.
 */
const sandbox = async (d: Pick<DoctorDeps, "home" | "run" | "platform" | "which">): Promise<Check[]> => {
  const platform = d.platform ?? process.platform;
  if (platform === "win32") return [warn("lane sandbox", "none: Windows has no lane sandbox, so lanes on this machine run WITHOUT one (each launch says SANDBOX_SKIPPED)", "none needed: Windows runners run lanes unsandboxed by design")];
  if (platform !== "linux" && platform !== "darwin") return [ok("lane sandbox", `not available on ${platform}; lanes on this machine need runners.<label>.allowUnsandboxed in the lead config`)];
  const mac = platform === "darwin";
  // A worker runner host runs its lanes behind the copy `dori runner install` puts in the runner's bin; the lead host uses ~/.local/bin.
  const worker = workerLabel(d) !== undefined;
  const installed = worker ? join(defaultRunnerDir(d.home), "bin", "lane-sandbox") : installedLaneSandbox(d.home);
  if (!existsSync(installed)) return [fail("lane sandbox", `${installed} is missing; lanes are refused (SANDBOX_MISSING)`, worker ? "rerun dori runner install for this machine from the lead" : "dori update (or restart the supervisor) installs it")];
  if (!mac && !(d.which ?? Bun.which)("bwrap")) return [fail("lane sandbox", "bwrap is not on PATH; lanes are refused", "install bubblewrap: sudo apt install bubblewrap")];
  const probe = await d.run([installed, "--check"], T);
  if (probe.code !== 0) return [fail("lane sandbox", `${installed} --check failed: ${probe.err.trim() || probe.out.trim() || `exit ${probe.code}`}`, mac ? "check that /usr/bin/sandbox-exec runs (sandbox-exec -p '(version 1)(allow default)' /usr/bin/true), then rerun dori doctor" : "fix bubblewrap (user namespaces enabled, AppArmor profile), then rerun dori doctor")];
  const template = mac ? LANE_SANDBOX_MACOS_TEMPLATE : LANE_SANDBOX_TEMPLATE;
  const refresh = worker ? "rerun dori runner install for this machine from the lead" : "dori update (or restart the supervisor) installs the template and keeps the old copy as lane-sandbox.bak";
  // A runner refuses every sandboxed lane start and recovery behind a wrapper that does not grant the lane-file directories.
  if (!probe.out.split(/\r?\n/).includes("DORI_LANE_FILES=1")) return [fail("lane sandbox", `${installed} --check does not print DORI_LANE_FILES=1; sandboxed lane starts and recoveries are refused (LANE_FILES_SANDBOX_OLD)`, refresh)];
  const installedHash = createHash("sha256").update(readFileSync(installed)).digest("hex");
  const templateHash = createHash("sha256").update(laneSandboxScript(template)).digest("hex");
  // Only a current wrapper is asked for its table: an older one has no --explain.
  const [exposed, allowed] = await Promise.all([exposure(d, installed), installedHash === templateHash ? permissions(d, installed) : undefined]);
  if (allowed) return [ok("lane sandbox", mac ? `${installed} works (seatbelt: sandbox-exec available)` : `${installed} works (bwrap available)`), exposed, allowed];
  return [warn("lane sandbox", `${installed} differs from templates/${basename(template)} (LANE_SANDBOX_OUTDATED)`, refresh), exposed];
};

/** Bound into every lane on purpose: gh drives PRs, and npm reads its registry settings. */
export const INTENDED = new Set([".config/gh", ".npmrc"]);
/**
 * Paths under $HOME the exposure probe checks: the credential stores the lane sandbox templates hide (CREDENTIAL_DENY)
 * and the ones bound on purpose. ~/.ssh private keys (id_*) are added from the host's ~/.ssh.
 */
export const SENSITIVE: readonly string[] = [...CREDENTIAL_DENY, ...INTENDED];
/** Prints each argument a lane could read: a file with its first byte, a directory with at least one entry (a hidden one is an empty tmpfs or refused). */
const PROBE = 'for p do if [ -d "$p" ]; then [ -n "$(ls -A "$p" 2>/dev/null)" ] && printf "%s\\n" "$p"; elif [ "$(head -c1 "$p" 2>/dev/null | wc -c)" -gt 0 ]; then printf "%s\\n" "$p"; fi; done; true';

/**
 * Which sensitive host paths a lane can read, measured by running a probe through the installed wrapper as a lane
 * (DORI_LANE_KEY set, cwd /): the credential stores above, ~/.ssh private keys and each path in ~/.dori/lane-sandbox-hide.
 * Only paths with content on the host are probed. The runner's worktree and repos roots are not part of the probe.
 */
const exposure = async (d: Pick<DoctorDeps, "home" | "run">, installed: string): Promise<Check> => {
  const nonEmpty = (p: string): boolean => {
    try {
      return statSync(p).isDirectory() ? readdirSync(p).length > 0 : statSync(p).size > 0;
    } catch {
      return false;
    }
  };
  let keys: string[] = [];
  try {
    keys = readdirSync(join(d.home, ".ssh")).filter((f) => /^id_[^/.]+$/.test(f)).map((f) => `.ssh/${f}`);
  } catch {
    // no ~/.ssh on this host
  }
  const hidePath = join(d.home, ".dori", "lane-sandbox-hide");
  const hidden = existsSync(hidePath) ? readFileSync(hidePath, "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean) : [];
  const candidates = [...new Set([...SENSITIVE, ...keys].map((p) => join(d.home, p)).concat(hidden))].filter(nonEmpty);
  if (candidates.length === 0) return ok("lane exposure", "none of the known credential stores exist on this host");
  // The wrapper binds a lane's input and output directories without -try (a lane missing its inputs must not start), so
  // the probe lane gets empty ones for the run.
  const briefs = join(defaultRunnerDir(d.home), "briefs");
  const laneDirs = ["doctor-probe.files", "doctor-probe.out"].map((n) => join(briefs, n));
  for (const dir of laneDirs) mkdirSync(dir, { recursive: true, mode: 0o700 });
  let probe: Awaited<ReturnType<Runner>>;
  try {
    probe = await d.run(["env", "DORI_LANE_KEY=doctor-probe", installed, "/bin/sh", "-c", PROBE, "lane-exposure", ...candidates], { ...T, cwd: "/" });
  } finally {
    for (const dir of laneDirs) rmSync(dir, { recursive: true, force: true });
  }
  if (probe.code !== 0) return warn("lane exposure", `could not probe what a lane can read (${probe.err.trim() || `exit ${probe.code}`})`, "run dori doctor again once the lane sandbox check passes");
  const seen = new Set(probe.out.split(/\r?\n/).filter(Boolean));
  const home = (p: string) => (p.startsWith(`${d.home}/`) ? `~/${p.slice(d.home.length + 1)}` : p);
  const intended = candidates.filter((p) => seen.has(p) && INTENDED.has(p.slice(d.home.length + 1)));
  const unexpected = candidates.filter((p) => seen.has(p) && !intended.includes(p));
  const onPurpose = intended.length ? `; bound on purpose: ${intended.map(home).join(", ")}` : "";
  if (unexpected.length) return warn("lane exposure", `a lane can read ${unexpected.map(home).join(", ")}${onPurpose}`, "dori update installs the current wrapper; list any other path in ~/.dori/lane-sandbox-hide");
  return ok("lane exposure", `${candidates.length - intended.length} sensitive path(s) checked, none readable in a lane${onPurpose}`);
};

/**
 * The $HOME dot entries a lane may read without a review: the paths the lane sandbox handles itself (bound, rebound or
 * hidden as a subtree) and the shells' and common tools' own files. A credential store's top entry (CREDENTIAL_DENY) is
 * known too.
 */
const KNOWN_HOME_ENTRIES: ReadonlySet<string> = new Set([
  ".dori", ".ssh", ".config", ".local", ".cache", ".omo", ".lane-tmp", ".bsk", ".npm", ".npm-global", ".bun", ".cargo", ".rustup", ".nvm",
  ".gitconfig", ".npmrc", ".profile", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".zshrc", ".zshenv", ".zprofile",
  ".zlogin", ".zlogout", ".oh-my-zsh", ".fzf", ".fzf.bash", ".fzf.zsh", ".inputrc", ".tmux.conf", ".vim", ".vimrc", ".viminfo",
  ".hushlogin", ".sudo_as_admin_successful", ".selected_editor", ".wget-hsts", ".motd_shown", ".landscape",
]);
/** What dori itself keeps directly in ~/.dori; its credential stores (CREDENTIAL_DENY) and the legacy guard files are known too. */
const KNOWN_DORI_ENTRIES: ReadonlySet<string> = new Set(["runner", "heavy", "lead", "research", "config.json", "src", "bin", "dori-boot-prep.sh", "freshness.log"]);

/**
 * Entries a lane can read that nobody has looked at: a $HOME dot entry or a ~/.dori entry outside the known sets above
 * and not in ~/.dori/lane-sandbox-hide. A lane sees $HOME and ~/.dori read-only, so a new tool's credential file there is
 * readable until it is hidden. Only hosts with a lane sandbox (Linux, macOS) are checked.
 */
const homeEntries = (d: Pick<DoctorDeps, "home" | "platform">): Check[] => {
  const platform = d.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") return [];
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const hidePath = join(d.home, ".dori", "lane-sandbox-hide");
  const hidden = new Set(existsSync(hidePath) ? readFileSync(hidePath, "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean) : []);
  const homeKnown = new Set([...KNOWN_HOME_ENTRIES, ...CREDENTIAL_DENY.map((p) => p.split("/")[0] as string)]);
  const doriKnown = new Set([...KNOWN_DORI_ENTRIES, ...LEGACY_GUARD_AGENT_FILES, ...CREDENTIAL_DENY.filter((p) => p.startsWith(".dori/")).map((p) => p.slice(".dori/".length))]);
  const unknown = [
    ...list(d.home).filter((n) => n.startsWith(".") && !homeKnown.has(n)).map((n) => [`~/${n}`, join(d.home, n)] as const),
    ...list(join(d.home, ".dori")).filter((n) => !doriKnown.has(n)).map((n) => [`~/.dori/${n}`, join(d.home, ".dori", n)] as const),
  ].filter(([, path]) => !hidden.has(path)).map(([shown]) => shown).sort();
  if (unknown.length) return [warn("lane home entries", `a lane can read ${unknown.join(", ")}, which dori does not know; check that none holds a credential`, "list each one that does in ~/.dori/lane-sandbox-hide")];
  return [ok("lane home entries", "every $HOME dot entry and ~/.dori entry is known or hidden")];
};

/**
 * What a lane on this host may touch, read off the installed wrapper's --explain table run as a lane with cwd / (so no
 * cwd is in it, nor the runner's worktree and repos roots and grants, which each lane adds). A row a later row overrides at
 * its own path is left out, as the table's later lines win.
 */
const permissions = async (d: Pick<DoctorDeps, "home" | "run">, installed: string): Promise<Check> => {
  const ran = await d.run(["env", "DORI_LANE_KEY=doctor-probe", installed, "--explain"], { ...T, cwd: "/" });
  if (ran.code !== 0) return warn("lane permissions", `${installed} --explain failed: ${(ran.err || ran.out).replace(/\s+/g, " ").trim() || `exit ${ran.code}`}`, "run dori doctor again once the lane sandbox check passes");
  const rows = ran.out.split(/\r?\n/).filter((l) => l !== "" && !l.startsWith("#")).map((l) => ({ mode: l.slice(0, l.indexOf(" ")), path: l.slice(l.indexOf(" ") + 1) }));
  const covers = (pattern: string, p: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")}(/|$)`).test(p);
  const home = (p: string) => (p === d.home ? "~" : p.startsWith(`${d.home}/`) ? `~/${p.slice(d.home.length + 1)}` : p);
  const list = (mode: string) => [...new Set(rows.filter((r) => r.mode === mode && r.path !== "/" && rows.findLast((o) => covers(o.path, r.path))?.mode === mode).map((r) => home(r.path)))];
  const parts = [["writable", list("rw")], ["hidden", list("hide")], ["empty (only the paths bound into it show)", list("empty")]] as const;
  const shown = parts.filter(([, paths]) => paths.length).map(([label, paths]) => `${label}: ${paths.join(", ")}`).join("; ");
  return ok("lane permissions", `${shown}; each lane adds its cwd, its runner's worktree and repos roots and its grants (the full table: DORI_LANE_KEY=<key> ${installed} --explain)`);
};

/** The label of a worker runner installed on this host (`dori runner install`); undefined on the lead host, whose runner is `local`. */
const workerLabel = (d: Pick<DoctorDeps, "home">): string | undefined => {
  try {
    const label = (JSON.parse(readFileSync(join(defaultRunnerDir(d.home), RUNNER_PATHS.identity), "utf8")) as { label?: unknown }).label;
    return typeof label === "string" && LABEL_PATTERN.test(label) && label !== LOCAL_RUNNER ? label : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The repair for an unreachable herdr on this host: the lead host's own unit (dori setup), or on a worker machine the
 * lead host's `dori runner herdr start` (herdr unit installed) or `dori runner install` (none yet).
 */
export const herdrFix = (d: Pick<DoctorDeps, "home" | "exists">): string => {
  const label = workerLabel(d);
  if (!label) return "systemctl --user start herdr-server.service";
  return herdrUnitInstalled({ home: d.home, exists: d.exists })
    ? `on the lead host: dori runner herdr start --machine ${label}`
    : `on the lead host: dori runner install --machine ${label} (installs the herdr unit)`;
};

const herdr = async (d: DoctorDeps): Promise<Check[]> => {
  const up = await d.run(["herdr", "workspace", "list"], T);
  if (up.code !== 0) return [fail("herdr", "server not reachable", herdrFix(d))];
  const procs = await d.run(["pgrep", "-f", "herdr server"], T);
  const n = procs.code === 0 ? procs.out.split("\n").filter(Boolean).length : 0;
  return [n > 1
    ? fail("herdr", `${n} herdr server processes`, "keep the unit's server and stop the others: pgrep -af 'herdr server'")
    : ok("herdr", "reachable, one server")];
};

const paths = async (d: DoctorDeps): Promise<Check[]> => {
  const wd = await d.run(["systemctl", "--user", "show", "dori-supervisor.service", "--property=WorkingDirectory", "--value"], T);
  const dir = wd.out.trim();
  const checks: Check[] = [];
  if (wd.code !== 0 || !dir) checks.push(fail("supervisor WorkingDirectory", "unit has no WorkingDirectory (status 200/CHDIR)", "dori setup --autostart"));
  else checks.push(d.exists(dir) ? ok("supervisor WorkingDirectory", dir) : fail("supervisor WorkingDirectory", `${dir} does not exist`, `mkdir -p ${dir}`));
  for (const [name, path] of [["leadCwd", d.config.leadCwd], ["stateDir", d.config.stateDir]] as const) {
    checks.push(d.exists(path) ? ok(name, path) : fail(name, `${path} does not exist`, `mkdir -p ${path}`));
  }
  return checks;
};

/**
 * The lead pane and lanes workspace the supervisor manages (dori state, not the config): each must exist in herdr. One
 * that is missing is a WARN, since the supervisor creates it at start and a launch re-creates the lanes workspace.
 * Legacy config keys naming them are reported as ignored.
 */
const managedPanes = async (d: DoctorDeps): Promise<Check[]> => {
  const c = d.config;
  const where = managedPanesPath(c.stateDir);
  const checks: Check[] = [];
  try {
    const raw: unknown = JSON.parse(readFileSync(d.configPath, "utf8"));
    const legacy = raw && typeof raw === "object" && !Array.isArray(raw) ? legacyPaneKeys(raw as Record<string, unknown>) : [];
    if (legacy.length) checks.push(warn("config pane keys", `${legacy.join(", ")} in ${d.configPath} are ignored; the supervisor manages them in ${where}`, `delete ${legacy.join(", ")} from ${d.configPath}`));
  } catch { /* the config check above already reports an unreadable config */ }
  const restart = "systemctl --user restart dori-supervisor.service";
  if (!c.leadPane) checks.push(warn("leadPane", `no lead pane recorded in ${where}`, restart));
  if (!c.laneWorkspace) checks.push(warn("lanes workspace", `no lanes workspace recorded in ${where}`, restart));
  if (!c.leadPane && !c.laneWorkspace) return checks;
  try {
    if (c.leadPane) {
      const found = (await listPanes(d.run)).some((p) => p.pane_id === c.leadPane);
      checks.push(found ? ok("leadPane", `${c.leadPane} exists in herdr`) : fail("leadPane", `${c.leadPane} is not a herdr pane`, "dori lead-restart"));
    }
    if (c.laneWorkspace) {
      const listed = await d.run(["herdr", "workspace", "list"], T);
      let found = false;
      try { found = listed.code === 0 && (JSON.parse(listed.out) as { result?: { workspaces?: { workspace_id?: string }[] } }).result?.workspaces?.some((w) => w.workspace_id === c.laneWorkspace) === true; } catch { found = false; }
      checks.push(found ? ok("lanes workspace", `${c.laneWorkspace} exists in herdr`) : warn("lanes workspace", `${c.laneWorkspace} is not a herdr workspace; the next launch or supervisor start finds or creates one`, restart));
    }
  } catch {
    checks.push(fail("leadPane", "cannot list herdr panes", "systemctl --user start herdr-server.service"));
  }
  return checks;
};

const isDiscord = (d: DoctorDeps): boolean => Boolean(d.config.discord) || d.config.discordChannels.length > 0 || d.token !== undefined;

const config = async (d: DoctorDeps): Promise<Check[]> => {
  if (d.configError) return [fail("config", `${d.configPath} does not load: ${d.configError}`, "fix the JSON, or dori setup")];
  if (!d.exists(d.configPath)) return [fail("config", `${d.configPath} is missing`, "dori setup")];
  const c = d.config;
  const missing = [
    ...(c.defaultModel ? [] : ["defaultModel"]),
    ...(c.discordChannels.length ? [] : ["discordChannels"]),
    ...(isDiscord(d) ? (["applicationId", "guildId", "ownerId"] as const).filter((k) => !/^\d+$/.test(c.discord?.[k] ?? "")).map((k) => `discord.${k}`) : []),
  ];
  const checks: Check[] = [missing.length
    ? fail("config", `missing or invalid: ${missing.join(", ")}`, "dori setup")
    : ok("config", "required keys present")];
  // Set but blank falls back to defaultModel / agentCommand's thinking, which is rarely what was meant.
  const blank = (["leadModel", "leadThinking"] as const).filter((k) => {
    const value: unknown = c[k];
    return k in c && !(typeof value === "string" && value.trim()) && !(k === "leadModel" && typeof value === "object" && value !== null && "model" in value && typeof value.model === "string" && value.model.trim());
  });
  if (blank.length) checks.push(warn("lead command", `${blank.join(", ")} set but blank; the lead uses the lane default`, `set a value or remove ${blank.join(", ")} from ${d.configPath}`));
  const pending = pendingLeadRestart(c.stateDir);
  if (pending) checks.push(warn("lead restart", `request ${pending.id}: ${pending.models.map((m) => m.thinking ? `${m.model} (thinking ${m.thinking})` : m.model).join(" -> ")}; applies at the next idle boundary, even below the context cap`, "wait for the lead to become idle; the supervisor applies the queued restart"));
  checks.push(...await managedPanes(d));
  return checks;
};

/** A value for one report line: objects show only their key names, so ids and argv stay short and secrets stay out. */
const shown = (v: unknown): string => {
  const s = v === undefined ? "(none)"
    : typeof v === "object" && v !== null && !Array.isArray(v) ? `{${Object.keys(v).join(", ")}}`
    : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

/**
 * Where each config value came from, following loadConfig (config.ts): `file` (config.json), `default` (defaultConfig),
 * `env` (DORI_CONFIG, DORI_STATE_DIR, DORI_LEAD_PANE) or `derived` (state on disk or another key). Keys in config.json
 * that loadConfig does not read are a WARN; the legacy pane keys are reported by the config check.
 */
export const configSources = (d: Pick<DoctorDeps, "config" | "configPath" | "configError" | "env">): Check[] => {
  if (d.configError) return [];
  const env = d.env ?? process.env;
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(d.configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch { /* no file: every value is a default, and the config check reports the missing file */ }
  const c = d.config;
  const values = c as Readonly<Record<string, unknown>>;
  const line = (key: string, source: string, value: unknown): Check => ok(`config.${key}`, `${source}: ${shown(value)}`);
  const checks: Check[] = [ok("config file", `${d.configPath} (${env.DORI_CONFIG ? "env DORI_CONFIG" : "default path"})`)];
  for (const key of CONFIG_FILE_KEYS) {
    const inFile = raw[key] !== undefined && raw[key] !== null;
    if (key === "stateDir" && env.DORI_STATE_DIR) checks.push(line(key, "env DORI_STATE_DIR", c.stateDir));
    else if (key === "alertsChannel" && !c.alertsChannel) checks.push(line(key, "derived from discordChannels[0]", alertsChannelOf(c)));
    else if (key === "decisionsChannel" && !c.decisionsChannel) checks.push(warn(`config.${key}`, "decisionsChannel: unset (decisions go to the requesting channel)", `add "decisionsChannel": "<channel id>" to ${d.configPath}`));
    else if (key === "leadModel" && !inFile) checks.push(line(key, "derived from defaultModel", c.defaultModel));
    else checks.push(line(key, inFile ? "file" : values[key] === undefined ? "unset" : "default", values[key]));
  }
  checks.push(
    line("store", `derived from ${c.stateDir}`, c.store),
    line("leadPane", env.DORI_LEAD_PANE ? "env DORI_LEAD_PANE" : "derived from the managed panes state", c.leadPane),
    line("laneWorkspace", "derived from the managed panes state", c.laneWorkspace),
  );
  const kept = CONFIG_FILE_KEYS as readonly string[];
  const ignored = Object.keys(raw).filter((key) => !kept.includes(key) && !legacyPaneKeys(raw).includes(key));
  if (ignored.length) checks.push(warn("config ignored keys", `${ignored.join(", ")} in ${d.configPath}: not read from config.json, the built-in values apply`, `delete ${ignored.join(", ")} from ${d.configPath} (dori setup --migrate)`));
  return checks;
};

const discord = async (d: DoctorDeps): Promise<Check[]> => {
  if (!isDiscord(d)) return [ok("discord", "not configured; skipped")];
  if (!d.token) return [fail("discord token", `DORI_DISCORD_TOKEN is not in ${d.envPath}`, "dori setup --token-file FILE")];
  const get = (path: string) => d.http({ method: "GET", url: `${API}${path}`, headers: { Authorization: `Bot ${d.token}` }, signal: AbortSignal.timeout(10_000) })
    .catch(() => ({ status: 0, headers: {}, body: "" }));
  const json = (body: string): unknown => { try { return JSON.parse(body); } catch { return undefined; } };
  const checks: Check[] = [];
  const me = await get("/users/@me");
  if (me.status !== 200) {
    const why = me.status === 0 ? "Discord API unreachable" : me.status === 401 ? "token rejected (401)" : `HTTP ${me.status}`;
    return [fail("discord token", why, me.status === 0 ? "check the network, then rerun dori doctor" : "dori setup --token-file FILE (reset the token in the Developer Portal if needed)")];
  }
  const name = (json(me.body) as { username?: unknown } | undefined)?.username;
  checks.push(d.tokenSource === "env"
    ? warn("discord token", "works, but only from the shell environment; the units read the env file", `add DORI_DISCORD_TOKEN to ${d.envPath} (dori setup --token-file FILE)`)
    : ok("discord token", `works${typeof name === "string" ? ` (bot ${name})` : ""}`));
  const dc = d.config.discord;
  const [guilds, app, chans] = await Promise.all([
    get("/users/@me/guilds"), get("/applications/@me"),
    Promise.all(d.config.discordChannels.map(async (id) => [id, (await get(`/channels/${id}/messages?limit=1`)).status] as const)),
  ]);
  if (dc) {
    const list = json(guilds.body);
    checks.push(guilds.status === 200 && Array.isArray(list) && list.some((g) => (g as { id?: unknown }).id === dc.guildId)
      ? ok("bot in guild", dc.guildId)
      : fail("bot in guild", guilds.status === 200 ? `bot is not in guild ${dc.guildId}` : `guild list HTTP ${guilds.status}`, "invite the bot: Developer Portal > OAuth2 > URL Generator (bot + applications.commands)"));
  }
  const bad = chans.filter(([, status]) => status !== 200);
  checks.push(bad.length
    ? fail("channels", bad.map(([id, s]) => `${id}: ${s === 403 ? "no access" : s === 404 ? "unknown channel" : `HTTP ${s}`}`).join("; "), "give the bot View Channel + Read Message History on each channel, or fix discordChannels")
    : ok("channels", `${chans.length} readable`));
  const flags = (json(app.body) as { flags?: unknown } | undefined)?.flags;
  checks.push(app.status !== 200 || typeof flags !== "number"
    ? warn("message content intent", `cannot read application flags (HTTP ${app.status})`, "check in the Developer Portal > Bot > Message Content Intent")
    : flags & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED)
      ? ok("message content intent", "enabled")
      : warn("message content intent", "not enabled; inbound text falls back to REST and can be empty", `Developer Portal > your application > Bot > enable Message Content Intent, then ${RESTART}`));
  if (dc) {
    const cmds = await get(`/applications/${dc.applicationId}/guilds/${dc.guildId}/commands`);
    const names = Array.isArray(json(cmds.body)) ? (json(cmds.body) as { name?: unknown }[]).map((c) => c.name) : [];
    const gone = ["quota", "status"].filter((n) => !names.includes(n));
    checks.push(cmds.status !== 200
      ? warn("slash commands", `cannot list guild commands (HTTP ${cmds.status})`, RESTART)
      : gone.length ? warn("slash commands", `not registered: ${gone.map((n) => `/${n}`).join(", ")}`, RESTART) : ok("slash commands", "/quota and /status registered"));
  }
  return checks;
};

const gateway = (d: DoctorDeps): Check[] => {
  const v = gatewayView(readGatewayStatus(d.config.stateDir), d.clock.now());
  if (v.state === "live") return [ok("gateway", v.text)];
  if (v.state === "no-content") return [warn("gateway", v.text, "enable Message Content Intent in the Developer Portal, then " + RESTART)];
  return [fail("gateway", v.text, RESTART)];
};

const issues = (d: DoctorDeps): Check[] => {
  const gh = githubSummary(d.config.stateDir);
  const poll = gh.polledAt === undefined ? "never polled" : `last poll ${new Date(gh.polledAt).toISOString().slice(0, 19)}Z`;
  const detail = `${gh.issueRepos.length} repos with an issue baseline, ${poll}`;
  return [d.config.githubIssueAuthors.length
    ? ok("github issues", `trusted authors ${d.config.githubIssueAuthors.join(", ")}; ${detail}`)
    : ok("github issues", `no trusted authors (githubIssueAuthors; set with dori setup), new issues stay digest; ${detail}`)];
};

const leadWakes = (d: DoctorDeps): Check[] => {
  // Owner messages are wanted wakes: only the rest count toward the threshold, and the warning names their top trigger.
  const wakes = readWakes(d.config.stateDir, d.clock.now() - 24 * 60 * 60_000).filter((wake) => wakeSource(wake.trigger) !== "owner");
  if (wakes.length <= LEAD_WAKE_WARNING_THRESHOLD) return [];
  const lane = wakes.filter((wake) => wakeSource(wake.trigger) === "lane").length;
  const triggers = new Map<string, number>();
  for (const wake of wakes) for (const kind of wake.trigger) triggers.set(kind, (triggers.get(kind) ?? 0) + 1);
  const [top, count] = [...triggers].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ["?", 0];
  return [warn("lead wakes",
    `${wakes.length} lead wakes not from owner messages in the last 24 hours (threshold ${LEAD_WAKE_WARNING_THRESHOLD}; lane ${lane}, noise ${wakes.length - lane}); most from ${top} (${count})`,
    "review dori status --stats for wake triggers and model calls")];
};

/** memoryCheck: the lead's human.md is found and within maxKb. */
const memory = (d: DoctorDeps): Check[] => {
  const m = d.config.memoryCheck;
  const repo = resolveMemoryRepo(d.config, d.home);
  const file = repo ? `${repo}/${MEMORY_FILE}` : undefined;
  const limit = Math.round(m.maxKb * 1024);
  const checks: Check[] = [];
  if (!file || !d.exists(file)) {
    checks.push(warn("memory check", file ? `${file} does not exist` : `no omo memory repo for ${d.config.leadCwd}; dori memory check and its sweep are off`, `check leadCwd in ${d.configPath}: the memory repo is omo's for that directory`));
  } else {
    const bytes = statSync(file).size;
    checks.push(bytes > limit
      ? warn("memory check", `${file} is ${(bytes / 1024).toFixed(1)}KB, over memoryCheck.maxKb ${m.maxKb}`, "dori memory check, then the lead condenses human.md")
      : ok("memory check", `${file} ${(bytes / 1024).toFixed(1)}KB of ${m.maxKb}KB`));
  }
  return checks;
};

const tools = async (d: DoctorDeps): Promise<Check[]> => {
  const [gh, auth, jq, bun, df] = await Promise.all([
    d.run(["gh", "--version"], T), d.run(["gh", "auth", "status"], T), d.run(["jq", "--version"], T), d.run(["bun", "--version"], T),
    d.run(["df", "-Pk", [d.config.stateDir, d.config.leadCwd].find((p) => d.exists(p)) ?? "/"], T),
  ]);
  const checks: Check[] = [
    gh.code !== 0 ? fail("gh", "not installed", "install gh: https://cli.github.com")
      : auth.code !== 0 ? fail("gh", "not authenticated", "gh auth login") : ok("gh", "installed, authenticated"),
    jq.code === 0 ? ok("jq", jq.out) : fail("jq", "not installed", "sudo apt install jq"),
    bun.code === 0 ? ok("bun", bun.out) : fail("bun", "not installed", "curl -fsSL https://bun.sh/install | bash"),
  ];
  const free = Number(df.out.split("\n").at(-1)?.trim().split(/\s+/)[3]) / 1024 / 1024;
  const min = d.config.guard.diskFreeMinGb;
  checks.push(df.code !== 0 || !Number.isFinite(free) ? warn("disk", "cannot read free space", "df -h")
    : free < min ? warn("disk", `${free.toFixed(1)} GB free, guard.diskFreeMinGb is ${min}`, "free disk space or lower guard.diskFreeMinGb in config.json")
    : ok("disk", `${free.toFixed(1)} GB free (guard ${min})`));
  return checks;
};

/** Open lanes waiting on recovery (freshness skips them): exhausted is a FAIL, still pending a WARN. Nothing when none. */
const recovery = async (d: DoctorDeps): Promise<Check[]> => {
  const registry = new Registry(d.config.stateDir);
  if (!d.exists(registry.dir)) return [];
  let lanes: RecoveryLane[];
  try { lanes = (await registry.open()).filter((l) => l.recoveryPending && statusOf(l) !== "closed"); }
  catch (e) { return [warn("lane recovery", `cannot read lanes: ${e instanceof Error ? e.message : String(e)}`, `check ${registry.dir}`)]; }
  const exhausted = lanes.filter((l) => l.recoveryExhausted);
  const pending = lanes.filter((l) => !l.recoveryExhausted);
  return [
    ...(exhausted.length ? [fail("lane recovery", `exhausted, not relaunched or nudged: ${exhausted.map((l) => `${l.key} (${l.recoveryAttempts ?? 0} attempts)`).join(", ")}`, "inspect each lane's pane, then relaunch it by hand or dori close <key>")] : []),
    ...(pending.length ? [warn("lane recovery", `pending, not nudged: ${pending.map((l) => l.key).join(", ")}`, "the supervisor's recover sweep retries; dori recover <key> runs it now")] : []),
  ];
};

/** Read-only: every probe is a status query or a GET. */
/**
 * Read-only runner checks: the local runner directory's permissions and per known runner protocol,
 * outbox backlog and restart circuit.
 */
export const runnerChecks = (d: Pick<DoctorDeps, "config" | "clock" | "home" | "exists">): Check[] => {
  const checks: Check[] = [];
  const legacyGuardFiles = legacyGuardAgentFiles(d.home);
  if (legacyGuardFiles.length) checks.push(warn("guard agent", `${legacyGuardFiles.join(", ")} left from the old standalone guard agent; the runner reports this host now`, "the runner removes them when it starts (dori update on the lead restarts runners); or delete them"));
  try {
    const endpoints = Object.entries(readRunnerEndpoints(d.config.stateDir));
    checks.push(endpoints.length
      ? ok("runner endpoints", endpoints.map(([label, endpoint]) => `${label}=${endpoint}`).join(", "))
      : warn("runner endpoints", "no worker endpoints recorded", "dori runner install --machine LABEL"));
  } catch (error) {
    checks.push(fail("runner endpoints", error instanceof Error ? error.message : String(error), "repair runner-endpoints.json or reinstall the worker"));
  }
  const dir = defaultRunnerDir(d.home);
  const rootsFile = join(dir, "runner-config.json");
  const roots = d.exists(rootsFile)
    ? "runner-config.json"
    : [d.home, tmpdir(), dirname(d.config.leadCwd), d.config.worktreeRoot].join(", ");
  checks.push(ok("runner policy", `effective allowedRoots: ${roots}`));
  if (d.exists(dir)) {
    try { checkRunnerDir(dir); checks.push(ok("runner dir", `${dir} 0700, files 0600, no symlinks`)); }
    catch (e) { checks.push(fail("runner dir", e instanceof Error ? e.message : String(e), `chmod -R go-rwx ${dir} and remove any symlink in it`)); }
  }
  const now = d.clock.now();
  let restarts: (label: string) => number = () => 0;
  try {
    const ops = openOperations(d.config);
    const rows = ops.list().filter((op) => op.action === "restart" && op.lane.startsWith("runner:") && now - op.at < RESTART_CIRCUIT_WINDOW_MS);
    ops.close();
    restarts = (label) => rows.filter((op) => op.lane === `runner:${label}`).length;
  } catch (e) {
    checks.push(warn("runner restarts", `cannot read the operations store: ${e instanceof Error ? e.message : String(e)}`, "dori doctor again once the supervisor has started"));
  }
  const rows = readRunnerRows(d.config.stateDir);
  for (const row of rows) {
    const id = `runner ${row.label}`;
    const problems: string[] = [];
    if (row.proto !== undefined && row.proto !== PROTO && row.proto !== PROTO - 1) problems.push(`proto ${row.proto} is not ${PROTO} or ${PROTO - 1}`);
    // Proto 9 adds lanes.closed: the previous proto still runs lanes and secrets but its cleanup sweep has no closed lanes to look at.
    else if (row.proto === PROTO - 1) problems.push(`proto ${row.proto} skips the closed lanes' node_modules cleanup (it needs proto ${PROTO})`);
    if (row.outbox && (row.outbox.unacked >= OUTBOX_LARGE_ROWS || row.outbox.oldestAgeMs >= OUTBOX_LARGE_AGE_MS)) problems.push(`outbox ${row.outbox.unacked} unacked, oldest ${Math.floor(row.outbox.oldestAgeMs / 3_600_000)} h`);
    if (restarts(row.label) >= RESTART_CIRCUIT_MAX) problems.push(`restart circuit open (${restarts(row.label)} restarts in the last hour)`);
    if (row.herdr === "down" || row.herdr === "hung" || row.herdr === "elevated") {
      // The runner saw its machine's herdr stop answering: its lanes cannot run there and their recovery is held.
      const since = row.herdrSince ? ` since ${new Date(row.herdrSince).toISOString()}` : "";
      const herdrProblem = row.herdr === "down" ? `herdr down${since} (no server process)`
        : row.herdr === "hung" ? `herdr hung${since} (the server process runs but does not answer)`
          : `herdr elevated${since} (the server runs as administrator and refuses the unelevated runner)`;
      // An elevated server cannot be ended by the unelevated runner, so dori runner herdr restart would be refused too.
      const command = row.herdr === "down"
        ? `dori runner herdr start --machine ${row.label}`
        : row.herdr === "hung"
          ? `dori runner herdr restart --machine ${row.label} --yes (ends every lane pane there; without --yes it lists them)`
          : HERDR_ELEVATED_FIX;
      const upgrade = row.proto !== undefined && row.proto < 4 ? `dori runner install --machine ${row.label} to upgrade (proto ${row.proto} has no host.herdr), then ` : "";
      checks.push(fail(id, [herdrProblem, ...problems].join("; "), `${upgrade}${command}`));
      continue;
    }
    checks.push(problems.length
      ? warn(id, problems.join("; "), `dori runner probe on that host; dori runner install --machine ${row.label} to upgrade`)
      : ok(id, `proto ${row.proto ?? "-"}, gen ${row.maxGen}, restarts1h ${restarts(row.label)}${row.herdr ? `, herdr ${row.herdr}` : ""}`));
  }
  // Runners whose lanes run without a sandbox (launch.ts sandboxChoice): Windows by design, others by opt-in.
  for (const label of new Set([...rows.map((row) => row.label), ...Object.keys(d.config.runners ?? {})])) {
    const os = rows.find((row) => row.label === label)?.machine?.os;
    const why = unsandboxedReason(d.config, label, os);
    if (!why) continue;
    checks.push(warn(`runner ${label} sandbox`, `none: runner ${label} ${why}, so its lanes run WITHOUT a sandbox (each launch says SANDBOX_SKIPPED)`,
      isWindowsOs(os) ? "none needed: Windows runners run lanes unsandboxed by design" : `remove runners.${label}.allowUnsandboxed from the lead config once that machine can sandbox`));
  }
  return checks;
};

const fileModeOf = (path: string): number | undefined => {
  try { return statSync(path).mode & 0o777; } catch { return undefined; }
};

/**
 * The secret store, inspected without reading or decrypting any value: entry names and backends through the store's
 * list, permission bits through stat. Warns on plain entries, a missing encryption backend, loose modes and allowlisted
 * names (config `secrets`) that are not stored.
 */
export const secretStoreChecks = async (d: Pick<DoctorDeps, "config" | "home" | "run" | "secretStore" | "modeOf">): Promise<Check[]> => {
  const id = "secret store";
  const store = d.secretStore ?? new SecretStore({ dir: join(d.home, ".dori", "secrets"), run: d.run });
  const modeOf = d.modeOf ?? fileModeOf;
  let entries: readonly SecretEntry[];
  try { entries = store.list(); }
  catch (e) { return [warn(id, e instanceof SecretStoreError ? e.message : `cannot list ${store.dir}: ${e instanceof Error ? e.message : String(e)}`, `chmod 700 ${store.dir}`)]; }
  const problems: string[] = [];
  const fixes: string[] = [];
  const plain = entries.filter((entry) => entry.backend === "plain");
  if (plain.length) {
    problems.push(`plain (unencrypted) entries: ${plain.map((entry) => entry.name).join(", ")}`);
    fixes.push("re-add it with dori secret update NAME on a host where systemd-creds --user works");
  }
  if (entries.length && !(await store.encryptionAvailable())) {
    problems.push("systemd-creds --user is unavailable");
    fixes.push("install or enable systemd-creds --user (systemd 250+), then re-add the secrets");
  }
  const dirMode = modeOf(store.dir);
  if (entries.length && dirMode !== undefined && dirMode !== 0o700) {
    problems.push(`${store.dir} mode is ${dirMode.toString(8)}, not 700`);
    fixes.push(`chmod 700 ${store.dir}`);
  }
  for (const entry of entries) {
    const path = join(store.dir, `${entry.name}.${entry.backend === "plain" ? "plain" : "cred"}`);
    const mode = modeOf(path);
    if (mode !== undefined && mode !== 0o600) {
      problems.push(`${path} mode is ${mode.toString(8)}, not 600`);
      fixes.push(`chmod 600 ${path}`);
    }
  }
  const allowed = Object.keys((d.config as { secrets?: Record<string, unknown> }).secrets ?? {});
  const stored = new Set(entries.map((entry) => entry.name));
  const missing = allowed.filter((name) => !stored.has(name));
  if (missing.length) {
    problems.push(`config secrets not in the store: ${missing.join(", ")}`);
    fixes.push("dori secret add NAME for each");
  }
  if (problems.length) return [warn(id, problems.join("; "), fixes.join("; "))];
  return [ok(id, entries.length ? `${entries.length} secrets, encrypted (systemd-creds)` : "no secrets stored")];
};

export const runDoctor = async (d: DoctorDeps): Promise<Check[]> =>
  (await Promise.all([units(d), herdr(d), paths(d), config(d), Promise.resolve(configSources(d)), discord(d), Promise.resolve(gateway(d)), Promise.resolve(issues(d)), Promise.resolve(leadWakes(d)), Promise.resolve(memory(d)), tools(d), recovery(d), Promise.resolve(runnerChecks(d)), sandbox(d), Promise.resolve(homeEntries(d)), secretStoreChecks(d)])).flat();

export const doctorExit = (checks: readonly Check[]): number => (checks.some((c) => c.level === "FAIL") ? 1 : 0);

export const renderDoctor = (checks: readonly Check[]): string => {
  const count = (l: Level) => checks.filter((c) => c.level === l).length;
  return [
    ...checks.flatMap((c) => [`${c.level.padEnd(4)} ${c.id}: ${c.detail}`, ...(c.fix && c.level !== "OK" ? [`     fix: ${c.fix}`] : [])]),
    `DOCTOR ok=${count("OK")} warn=${count("WARN")} fail=${count("FAIL")}`,
  ].join("\n");
};

export const realDoctorDeps = async (): Promise<DoctorDeps> => {
  const path = configPath();
  let cfg = defaultConfig();
  let configError: string | undefined;
  try { cfg = await loadConfig(path); } catch (e) { configError = e instanceof Error ? e.message : String(e); }
  const envPath = join(homedir(), ".dori", "env");
  const fromFile = tokenFrom(existsSync(envPath) ? readFileSync(envPath, "utf8") : undefined);
  const token = fromFile ?? process.env.DORI_DISCORD_TOKEN;
  return {
    run, http: fetchHttp, clock: realClock, config: cfg, configPath: path, ...(configError ? { configError } : {}), envPath,
    ...(token ? { token, tokenSource: fromFile ? "file" as const : "env" as const } : {}), exists: existsSync, home: homedir(),
  };
};

/** Prints the report and returns the exit code. */
export const doctorMain = async (log: (line: string) => void = console.log): Promise<number> => {
  const checks = await runDoctor(await realDoctorDeps());
  log(renderDoctor(checks));
  return doctorExit(checks);
};
