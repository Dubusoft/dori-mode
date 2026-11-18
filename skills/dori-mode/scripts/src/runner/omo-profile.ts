import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The omo profile a macOS lane runs under (templates/lane-sandbox-macos.sh sets OMO_PROFILE to it). omo wraps its memory
 * reflection child in a sandbox-exec of its own, and macOS refuses to apply a sandbox inside the lane's Seatbelt profile
 * ("sandbox_apply: Operation not permitted"), so every reflection a lane started failed. This profile turns that inner
 * sandbox off; the reflection child still runs inside the lane's sandbox.
 */
export const OMO_LANE_PROFILE = "dori-lane";

export const omoUserConfig = (home: string): string => join(home, ".omo", "omo.jsonc");

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `text` (a user omo.jsonc, undefined when there is none) with `profiles["dori-lane"].memory.reflection.sandbox` set to
 * "off", every other key kept; undefined when it is "off" already. Throws when the text is not a JSONC object or a key
 * on that path holds something other than an object.
 */
export const withLaneProfile = (text: string | undefined): string | undefined => {
  const parsed: unknown = text === undefined || text.trim() === "" ? {} : Bun.JSONC.parse(text);
  if (!isObject(parsed)) throw new Error("not a JSONC object");
  let node = parsed;
  for (const key of ["profiles", OMO_LANE_PROFILE, "memory", "reflection"]) {
    const next = node[key] ?? {};
    if (!isObject(next)) throw new Error(`${key} is not an object`);
    node[key] = next;
    node = next;
  }
  if (node.sandbox === "off") return undefined;
  node.sandbox = "off";
  return `${JSON.stringify(parsed, null, 2)}\n`;
};

/**
 * Adds the dori-lane profile to `home`'s ~/.omo/omo.jsonc when it lacks it. The file (a symlink's target) is rewritten
 * through a renamed temporary copy with its mode kept, and the previous text stays beside it as omo.jsonc.bak.dori-lane,
 * since the rewrite drops JSONC comments. Returns the line to print, or undefined when nothing changed.
 */
export const ensureOmoLaneProfile = (home: string): string | undefined => {
  const link = omoUserConfig(home);
  const file = existsSync(link) ? realpathSync(link) : link;
  const old = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const next = withLaneProfile(old);
  if (next === undefined) return undefined;
  mkdirSync(dirname(file), { recursive: true });
  const mode = old === undefined ? 0o644 : statSync(file).mode & 0o777;
  if (old !== undefined) copyFileSync(file, `${file}.bak.${OMO_LANE_PROFILE}`);
  const tmp = `${file}.${OMO_LANE_PROFILE}-${process.pid}`;
  writeFileSync(tmp, next);
  chmodSync(tmp, mode);
  renameSync(tmp, file);
  return `OMO_LANE_PROFILE_ADDED ${file}: profiles.${OMO_LANE_PROFILE}.memory.reflection.sandbox is off`;
};
