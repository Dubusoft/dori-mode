import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The file the supervisor unit loads with EnvironmentFile (written by `dori setup`). */
export const envFilePath = (home = homedir()): string => join(home, ".dori", "env");

const ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/gm;

/**
 * Every `KEY=value` entry of env-file text, in file order. Like systemd's EnvironmentFile, a value opened with a quote runs
 * to its closing quote across lines (inside double quotes `\"` and `\\` are escapes); a quote that never closes, like an
 * unquoted value, takes the rest of its line, trimmed.
 */
export const parseEnvFile = (text: string): (readonly [name: string, value: string])[] => {
  const entries: (readonly [string, string])[] = [];
  const re = new RegExp(ASSIGNMENT);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = re.lastIndex;
    const quote = text[start];
    if (quote === '"' || quote === "'") {
      let value = "";
      let i = start + 1;
      for (; i < text.length && text[i] !== quote; i++) {
        if (quote === '"' && text[i] === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) i++;
        value += text[i];
      }
      if (i < text.length) {
        entries.push([m[1] ?? "", value]);
        const eol = text.indexOf("\n", i);
        re.lastIndex = eol < 0 ? text.length : eol;
        continue;
      }
    }
    const eol = text.indexOf("\n", start);
    entries.push([m[1] ?? "", text.slice(start, eol < 0 ? text.length : eol).trim()]);
    re.lastIndex = eol < 0 ? text.length : eol;
  }
  return entries;
};

/** The first non-blank value of `name` in env-file text; blank counts as unset. */
export const envFileValue = (text: string, name: string): string | undefined =>
  parseEnvFile(text).find(([key, value]) => key === name && value)?.[1];

/**
 * Resolves a messenger credential the way the supervisor sees it: the process environment first, then the
 * private env file. A process that did not inherit the unit's environment (a restarted lead's tool calls)
 * still finds it there. Callers must never print the returned value.
 */
export const resolveCredential = (name: string, env: Readonly<Record<string, string | undefined>> = process.env, home = env.HOME || homedir()): string | undefined => {
  const fromEnv = env[name]?.trim();
  if (fromEnv) return fromEnv;
  const path = envFilePath(home);
  try {
    return envFileValue(readFileSync(path, "utf8"), name);
  } catch {
    return undefined;
  }
};
