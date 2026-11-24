import type { Runner, RunOptions } from "./run.ts";
import { oneLine } from "./line-text.ts";

/** A `gh ... --json` answer read as JSON of the expected shape, or why it could not be: `code` is gh's exit code (0 when gh succeeded but printed something else). */
export type GhJson<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string; readonly code: number };


/**
 * Runs `argv` (a gh command printing JSON) and reads its answer. A failed or timed-out run, output that is not JSON
 * (a warning, a proxy page, nothing at all) and JSON that is not the expected `shape` each come back as `error`, never
 * as a throw. Fields past the shape are not checked: callers read them as optional.
 */
export const ghJson = async <T>(run: Runner, argv: readonly string[], shape: "object" | "array", opts?: RunOptions): Promise<GhJson<T>> => {
  const r = await run(argv, opts);
  if (r.code !== 0 || r.timedOut) return { ok: false, error: oneLine(r.err || r.out, 160) || `gh exited ${r.code}`, code: r.code };
  let value: unknown;
  try {
    value = JSON.parse(r.out);
  } catch {
    return { ok: false, error: `gh answered no JSON: ${oneLine(r.out, 160) || "(empty)"}`, code: 0 };
  }
  const fits = shape === "array" ? Array.isArray(value) : value !== null && typeof value === "object" && !Array.isArray(value);
  return fits ? { ok: true, value: value as T } : { ok: false, error: `gh answered JSON that is not an ${shape}: ${oneLine(r.out, 160)}`, code: 0 };
};
