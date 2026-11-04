export type Platform = "discord";
export type Target = { readonly to: string; readonly thread?: string };

/**
 * `dori send --to` takes a plain id or a lane thread ref (`discord:parent/thread`, as stored in `lane.thread`).
 * A Discord thread is a channel, so the thread id is the destination; an explicit `--thread` wins over the ref's.
 */
/** A lane thread value in ref form: a bare Discord id (as older launches stored it) becomes `discord:<id>`; anything else is kept. */
export const normalizeThreadRef = (value: string): string => (/^\d+$/.test(value) ? `discord:${value}` : value);

/**
 * The Discord thread a target names, or undefined when it names a channel or is no Discord target: `discord:<channel>/<thread>`
 * names its thread; `discord:<id>` and a bare id name a thread unless the id is a configured channel (`discordChannels`).
 */
export const discordThreadOf = (ref: string, channels: readonly string[]): string | undefined => {
  const [, id = "", thread] = /^(?:discord:)?(\d+)(?:\/(\d+))?$/.exec(ref) ?? [];
  if (thread) return thread;
  return id && !channels.includes(id) ? id : undefined;
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

export const resolveTarget = (platform: Platform, to: string, thread?: string): Target => {
  const prefix = `${platform}:`;
  // An explicit --thread is the destination, as before the ref syntax existed.
  if (!to.startsWith(prefix)) return { to: thread ?? to };
  const [parent = "", child = ""] = to.slice(prefix.length).split("/");
  if (!parent) throw new Error(`bad thread ref "${to}"`);
  return { to: thread ?? (child || parent) };
};
