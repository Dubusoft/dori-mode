export type Platform = "discord";
export type Target = { readonly to: string; readonly thread?: string };

/**
 * A lane thread value in ref form: a bare Discord id becomes `discord:<id>`; anything else is kept.
 */
export const normalizeThreadRef = (value: string): string => (/^\d+$/.test(value) ? `discord:${value}` : value);

/**
 * `dori send --to` takes a plain id or a lane thread ref (`discord:parent/thread`, as stored in `lane.thread`).
 * A Discord thread is a channel, so the thread id is the destination; an explicit `--thread` wins over the ref's.
 */
export const discordThreadOf = (ref: string, channels: readonly string[]): string | undefined => {
  const [, id = "", thread] = /^(?:discord:)?(\d+)(?:\/(\d+))?$/.exec(ref) ?? [];
  const named = thread ?? id;
  return named && !channels.includes(named) ? named : undefined;
};

/**
 * A lane's `--thread` as it is stored: `discord:<channel>/<thread>` when the value names only a thread and `parentOf` finds
 * its parent channel; otherwise the value in ref form. `parentOf` returns undefined for a channel that is no thread.
 */
export const withThreadParent = async (value: string, channels: readonly string[], parentOf: (thread: string) => Promise<string | undefined>): Promise<string> => {
  const ref = normalizeThreadRef(value);
  const id = /^discord:(\d+)$/.exec(ref)?.[1];
  if (!id || channels.includes(id)) return ref;
  const parent = await parentOf(id);
  return parent ? `discord:${parent}/${id}` : ref;
};

/**
 * Resolves a `dori send --to` value and optional explicit `--thread` destination.
 * A plain id is kept as the destination; a lane thread ref uses its thread id, or the id itself when no child is present.
 */
export const resolveTarget = (platform: Platform, to: string, thread?: string): Target => {
  const prefix = `${platform}:`;
  // An explicit --thread is the destination.
  if (!to.startsWith(prefix)) return { to: thread ?? to };
  const [parent = "", child = ""] = to.slice(prefix.length).split("/");
  if (!parent) throw new Error(`bad thread ref "${to}"`);
  return { to: thread ?? (child || parent) };
};
