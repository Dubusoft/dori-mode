export type Platform = "discord";
export type Target = { readonly to: string; readonly thread?: string };

/**
 * `dori send --to` takes a plain id or a lane thread ref (`discord:parent/thread`, as stored in `lane.thread`).
 * A Discord thread is a channel, so the thread id is the destination; an explicit `--thread` wins over the ref's.
 */
export const resolveTarget = (platform: Platform, to: string, thread?: string): Target => {
  const prefix = `${platform}:`;
  // An explicit --thread is the destination, as before the ref syntax existed.
  if (!to.startsWith(prefix)) return { to: thread ?? to };
  const [parent = "", child = ""] = to.slice(prefix.length).split("/");
  if (!parent) throw new Error(`bad thread ref "${to}"`);
  return { to: thread ?? (child || parent) };
};
