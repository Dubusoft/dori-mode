import { existsSync, readFileSync, statSync } from "node:fs";
import { envFilePath } from "./credentials.ts";

const MASK = "[REDACTED]";

/** Env names whose values are credentials: a name ending in one of these words, or containing WEBHOOK/CREDENTIAL. */
const SECRET_NAME = /(?:TOKEN|SECRET|KEY|COOKIE|PASSWORD|PASSWD)$|WEBHOOK|CREDENTIAL/i;
const MIN_KNOWN_SECRET = 8;

let envCache: { readonly key: string; readonly values: readonly string[] } | undefined;

/** Secret values of the dori env file (`~/.dori/env`), re-read when the file changes; none when it is absent or unreadable. */
const envFileSecrets = (): readonly string[] => {
  let path: string;
  try { path = envFilePath(process.env.HOME || undefined); } catch { return []; }
  if (!existsSync(path)) return [];
  try {
    const st = statSync(path);
    const key = `${path}:${st.mtimeMs}:${st.size}`;
    if (envCache?.key === key) return envCache.values;
    const values: string[] = [];
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!m || !SECRET_NAME.test(m[1] ?? "")) continue;
      const value = (m[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
      if (value.length >= MIN_KNOWN_SECRET) values.push(value);
    }
    envCache = { key, values };
    return values;
  } catch { return []; }
};

/** Exact-match masking of the secret values the env file and the process environment carry, longest value first. */
const maskKnownSecrets = (text: string): string => {
  const known = new Set(envFileSecrets());
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= MIN_KNOWN_SECRET && SECRET_NAME.test(name)) known.add(value);
  }
  let out = text;
  for (const value of [...known].sort((a, b) => b.length - a.length)) if (out.includes(value)) out = out.split(value).join(MASK);
  return out;
};

/**
 * A `key=value` / `"key": "value"` assignment. A count or an ordinary word stays. Masked: any value of 16+ characters, a
 * password made of 4+ digits (a PIN), and anything of 5+ characters mixing letters and nonletters. A quoted JSON key keeps
 * the value's quotes so the surrounding JSON stays well formed.
 */
const assignment = (match: string, prefix: string, raw: string): string => {
  const value = /^["']/.test(raw) ? raw.slice(1, -1) : raw;
  const long = value.length >= 16;
  const pin = /^(?:password|passwd|pwd)/i.test(prefix) && /^\d{4,}$/.test(value);
  const mixed = value.length >= 5 && /\p{L}/u.test(value) && /[^\p{L}]/u.test(value);
  if (value === MASK || !(long || pin || mixed)) return match;
  return `${prefix}${/["']\s*[=:]\s*$/.test(prefix) && /^["']/.test(raw) ? `${raw[0]}${MASK}${raw[0]}` : MASK}`;
};

// Order matters: block/prefixed forms first, generic assignments last.
const RULES: readonly (readonly [RegExp, string | ((...m: string[]) => string)])[] = [
  [/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, `[REDACTED PRIVATE KEY]`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  // Slack `d` cookie: the value is URL-encoded, so it runs past the characters other xox tokens use.
  [/\bxoxd-[^\s"';,]{10,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, MASK],
  // Telegram bot token: <bot id>:<35 chars>, also inside /bot<token>/ URLs.
  [/(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g, MASK],
  // Discord bot token: three base64url segments, first starts with a snowflake encoding (M/N/O).
  [/\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g, MASK],
  // Discord webhook URL: its last segment is the token that lets anyone post.
  [/(\bdiscord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]{20,}/g, (_m, p) => `${p}${MASK}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, (_m, p) => `${p}${MASK}`],
  // Prefixed names (EXPO_TOKEN, DORI_SLACK_COOKIE, client_secret): `\b` cannot start inside `_`.
  [/(?<![A-Za-z0-9])((?:[A-Za-z0-9]+_)+(?:token|secret|key|cookie|password|passwd)["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&}]+)/gi, assignment],
  // The key may be a quoted JSON key ("token": "...").
  [/\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&}]+)/gi, assignment],
];

/** Mask common credential shapes in outbound text. Ordinary text is returned unchanged. */
export const redactSecrets = (text: string): string => {
  let out = maskKnownSecrets(text);
  for (const [re, to] of RULES) out = out.replace(re, to as never);
  return out;
};

/** `redactSecrets` over every string value of an event's structured context. */
export const redactMeta = <T extends Readonly<Record<string, string | undefined>>>(meta: T): T =>
  Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, typeof value === "string" ? redactSecrets(value) : value])) as T;
