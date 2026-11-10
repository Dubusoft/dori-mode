import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Clock } from "./run.ts";

export type SlotDeps = {
  readonly dir: string;
  readonly slots: number;
  readonly maxLoad: number;
  readonly clock: Clock;
  readonly load: () => Promise<number>;
  readonly alive: (pid: number, sinceMs?: number) => boolean;
  readonly pid: number;
  /** Defaults to `process.platform`; `win32` takes the Windows claim and stamp. */
  readonly platform?: string;
};

const ORPHAN_MS = 60_000;
/** The slack allowed on win32 between the slot stamp (seconds precision) and the owner's start time. */
const START_SLACK_MS = 1_000;

const stamp = (ms: number, win: boolean): string => {
  const iso = new Date(ms).toISOString();
  return win ? iso.replace(/\.\d{3}Z$/, "Z") : iso;
};

const tryTake = (deps: SlotDeps, n: number, label: string): string | null => {
  const slot = join(deps.dir, `slot.${n}`);
  const win = (deps.platform ?? process.platform) === "win32";
  const claim = (): string | null => {
    const text = `${deps.pid} ${label} ${stamp(deps.clock.now(), win)}`;
    if (win) {
      try {
        mkdirSync(slot, { recursive: true });
        writeFileSync(join(slot, "owner"), text, { flag: "wx" });
      } catch {
        return null;
      }
      return slot;
    }
    try {
      mkdirSync(slot);
    } catch {
      return null;
    }
    writeFileSync(join(slot, "owner"), text);
    return slot;
  };
  const got = claim();
  if (got) return got;
  let owner = "";
  try {
    owner = readFileSync(join(slot, "owner"), "utf8");
  } catch {
    owner = "";
  }
  const pid = Number(owner.split(" ")[0]);
  const since = win ? Date.parse(owner.trim().split(/\s+/).pop() ?? "") : NaN;
  const orphaned = owner ? !(win && Number.isFinite(since) ? deps.alive(pid, since) : deps.alive(pid)) : deps.clock.now() - statSync(slot).mtimeMs > ORPHAN_MS;
  if (!orphaned) return null;
  rmSync(slot, { recursive: true, force: true });
  return claim();
};

/** One attempt: a free slot while the load is below maxLoad, else null (a scheduled job tries again on its next pass). */
export const trySlot = async (deps: SlotDeps, label: string): Promise<string | null> => {
  mkdirSync(deps.dir, { recursive: true });
  if ((await deps.load()) >= deps.maxLoad) return null;
  for (let n = 1; n <= deps.slots; n++) {
    const slot = tryTake(deps, n, label);
    if (slot) return slot;
  }
  return null;
};

export const acquireSlot = async (deps: SlotDeps, label: string, pollMs = 15_000): Promise<string> => {
  for (;;) {
    const slot = await trySlot(deps, label);
    if (slot) return slot;
    await deps.clock.sleep(pollMs);
  }
};

export const releaseSlot = (slot: string): void => rmSync(slot, { recursive: true, force: true });

const FILETIME_UNIX_EPOCH_MS = 11_644_473_600_000;

let winCreated: ((pid: number) => number | undefined) | undefined;

/** Process creation time in epoch ms through kernel32 `GetProcessTimes`, loaded on first use; undefined when unreadable. */
const winCreatedMs = (pid: number): number | undefined => {
  if (!winCreated) {
    const { dlopen, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const k32 = dlopen("kernel32.dll", {
      OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
      GetProcessTimes: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
      CloseHandle: { args: ["ptr"], returns: "i32" },
    });
    winCreated = (target) => {
      const handle = k32.symbols.OpenProcess(0x1000, 0, target);
      if (!handle) return undefined;
      try {
        const times = new BigUint64Array(4);
        const at = (i: number) => ptr(times.subarray(i, i + 1));
        if (!k32.symbols.GetProcessTimes(handle, at(0), at(1), at(2), at(3))) return undefined;
        return Number((times[0] ?? 0n) / 10_000n) - FILETIME_UNIX_EPOCH_MS;
      } finally {
        k32.symbols.CloseHandle(handle);
      }
    };
  }
  try {
    return winCreated(pid);
  } catch {
    return undefined;
  }
};

export type AliveOptions = {
  readonly platform?: string;
  readonly createdMs?: (pid: number) => number | undefined;
};

/** Whether `pid` is a live process; on win32 with `sinceMs`, also that it started no later than a second after that stamp. */
export const pidAlive = (pid: number, sinceMs?: number, opts: AliveOptions = {}): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if ((opts.platform ?? process.platform) === "win32") {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "EPERM") return false;
    }
    if (sinceMs === undefined) return true;
    const created = (opts.createdMs ?? winCreatedMs)(pid);
    return created === undefined || created <= sinceMs + START_SLACK_MS;
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    } catch {
      // /proc may be unavailable in a container; use the portable check below.
    }
  }
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
  return stat !== "" && !stat.startsWith("Z");
};

export const alive = pidAlive;
