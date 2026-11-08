import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeRunnerFile } from "./fs-safety.ts";
import { LABEL_PATTERN } from "./protocol.ts";

export const RUNNER_MACHINES_FILE = "runner-machines.json";

const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[[0-9A-Fa-f:.]+\]$/;

/** `user@host`, `host` or `[v6]`; throws on empty input, whitespace, a leading `-` (an ssh option) or a malformed part. */
export const parseInstallTarget = (raw: string): { target: string; host: string } => {
  const at = raw.lastIndexOf("@");
  const user = at < 0 ? undefined : raw.slice(0, at);
  const host = at < 0 ? raw : raw.slice(at + 1);
  if (!raw || (user !== undefined && !USER.test(user)) || !HOST.test(host)) throw new Error(`RUNNER_TARGET_INVALID ${JSON.stringify(raw)}`);
  return { target: raw, host };
};

/** A LABEL_PATTERN-safe slug of the host part: 100.64.1.2 -> 100-64-1-2, mini.lan -> mini-lan. */
export const labelFromHost = (host: string): string => {
  const label = host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!LABEL_PATTERN.test(label)) throw new Error(`RUNNER_TARGET_INVALID cannot derive a label from ${JSON.stringify(host)}; pass --label`);
  return label;
};

/** label -> ssh target of machines installed by `dori runner install <target>`; supervisor state, not config. A bad file reads as empty. */
export const readRunnerMachines = (stateDir: string): Record<string, string> => {
  const path = join(stateDir, RUNNER_MACHINES_FILE);
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => LABEL_PATTERN.test(e[0]) && typeof e[1] === "string" && e[1] !== ""));
  } catch {
    return {};
  }
};

/** Atomically add or replace one label, keeping the others; mode 0600. */
export const writeRunnerMachine = (stateDir: string, label: string, target: string): void => {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeRunnerFile(join(stateDir, RUNNER_MACHINES_FILE), `${JSON.stringify({ ...readRunnerMachines(stateDir), [label]: target }, null, 2)}\n`);
};
