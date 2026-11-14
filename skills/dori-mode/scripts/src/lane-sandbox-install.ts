import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LANE_SANDBOX_TEMPLATE = fileURLToPath(new URL("../templates/lane-sandbox.sh", import.meta.url));
/** The macOS (Seatbelt) wrapper `dori runner install` puts on a Mac runner; same inputs as the Linux one. */
export const LANE_SANDBOX_MACOS_TEMPLATE = fileURLToPath(new URL("../templates/lane-sandbox-macos.sh", import.meta.url));

export const installedLaneSandbox = (home: string): string => join(home, ".local", "bin", "lane-sandbox");

/**
 * Credential stores and secrets under $HOME no lane may read, files and directories alike: the one list both lane
 * sandbox templates hide (rendered into their CREDENTIALS block by laneSandboxScript) and `dori doctor` probes. A lane
 * gets a credential only through the secret broker. An entry may be a glob (* and ? within one path component, [...] a
 * class): Linux hides each existing match, macOS refuses every path it matches. Paths that need a subtree hidden with parts of it re-opened
 * (~/.dori/runner, ~/.ssh, ~/.config) are handled by each template itself, not listed here.
 */
export const CREDENTIAL_DENY: readonly string[] = [
  // dori's own secrets and supervisor state
  ".dori/env", ".dori/secrets", ".dori/state", ".dori/lane-sandbox-hide", ".dori/gateway-locks", ".secrets",
  // cloud
  ".aws", ".azure", ".oci", ".kube", ".config/gcloud", ".config/doctl", ".config/hcloud", ".config/flyctl", ".config/helm",
  ".terraform.d/credentials.tfrc.json", ".vault-token",
  // docker and containers
  ".docker/config.json", ".config/containers/auth.json",
  // gpg, keyrings and password managers
  ".gnupg", ".password-store", ".local/share/keyrings", ".local/share/gnome-keyring", ".local/share/kwalletd", ".config/age", ".age",
  ".config/sops", ".config/Bitwarden", ".config/keepassxc", ".config/1Password",
  // git hosts and package registries
  ".git-credentials", ".netrc", ".pypirc", ".cargo/credentials", ".cargo/credentials.toml", ".gem/credentials", ".m2/settings.xml",
  ".gradle/gradle.properties", ".config/composer/auth.json", ".yarnrc", ".yarnrc.yml", ".pnpmrc", ".config/pnpm/auth.ini", ".config/glab-cli",
  ".nuget/NuGet", ".config/gh/hosts.yml",
  // toodo's server tokens
  ".local/share/toodo-server",
  // browser and chat app profiles
  ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge", ".config/discord", ".config/Slack",
  ".config/Signal", ".local/share/TelegramDesktop", ".config/Code/User/globalStorage", ".vscode", ".vscode-server",
  // shell and REPL history
  ".*_history", ".lesshst",
];

const CREDENTIALS_BLOCK = /^# BEGIN CREDENTIALS\b.*\n[\s\S]*?^# END CREDENTIALS$/m;

/** The CREDENTIALS block of a template: CREDENTIAL_DENY as one space-separated shell string, wrapped under 120 columns. */
const credentialsBlock = (): string => {
  const lines: string[] = [];
  let line = 'CREDENTIALS="';
  for (const p of CREDENTIAL_DENY) {
    if (/[\s"'$`\\]/.test(p)) throw new Error(`CREDENTIAL_DENY entry ${p} is not a plain path or glob`);
    if (line.length + p.length + 1 > 118) { lines.push(line.trimEnd()); line = "  "; }
    line += `${p} `;
  }
  lines.push(`${line.trimEnd()}"`);
  return ["# BEGIN CREDENTIALS (rendered from CREDENTIAL_DENY in src/lane-sandbox-install.ts; edit the list there)", ...lines, "# END CREDENTIALS"].join("\n");
};

/** The lane sandbox script installed from `template`: the template with its CREDENTIALS block rendered from CREDENTIAL_DENY. */
export const laneSandboxScript = (template: string): string => {
  const text = readFileSync(template, "utf8");
  if (!CREDENTIALS_BLOCK.test(text)) throw new Error(`${template} has no "# BEGIN CREDENTIALS" ... "# END CREDENTIALS" block`);
  return text.replace(CREDENTIALS_BLOCK, credentialsBlock());
};

/**
 * Replaces an installed `~/.local/bin/lane-sandbox` that differs from the template with the template, keeping the old
 * copy as `lane-sandbox.bak`, so new lanes get the template's mounts (their own lane token and the runner socket). The new
 * file is renamed into place, so a lane whose shell is still reading the old script keeps its own inode. A missing install
 * is left missing: launch then refuses local lanes (SANDBOX_MISSING) and `dori doctor` reports it. Returns the line to log, if any.
 */
export const refreshLaneSandbox = (home: string, template?: string, platform: NodeJS.Platform = process.platform): string | undefined => {
  template ??= platform === "darwin" ? LANE_SANDBOX_MACOS_TEMPLATE : LANE_SANDBOX_TEMPLATE;
  const installed = installedLaneSandbox(home);
  if (!existsSync(installed)) return undefined;
  const want = Buffer.from(laneSandboxScript(template));
  if (readFileSync(installed).equals(want)) return undefined;
  copyFileSync(installed, `${installed}.bak`);
  const next = `${installed}.new-${process.pid}`;
  writeFileSync(next, want);
  chmodSync(next, 0o755);
  renameSync(next, installed);
  return `LANE_SANDBOX_UPDATED ${installed} from templates/${basename(template)}; the previous copy is ${installed}.bak`;
};
