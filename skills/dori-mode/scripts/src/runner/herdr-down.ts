import { readRunnerRows } from "./hub.ts";
import type { AnyRunnerEvent } from "./protocol.ts";
import { LOCAL_RUNNER } from "./serve.ts";

/**
 * Explicit protocol-4 herdr transitions and snapshots, with protocol-3 pane-count inference on the supervisor. A runner's
 * `guard.sample.panes` is -1 when it could not read herdr's pane list. That many samples in a row
 * (HERDR_DOWN_SAMPLES; the runner sends one a minute) mark the runner's machine's herdr `down`: `HERDR_DOWN
 * machine=<label>` once, and the state is saved on the runner's hub row. The next sample with a pane count marks it
 * `up` again: `HERDR_UP machine=<label>` once. The first readable sample of a runner with no saved state saves `up`
 * and says nothing. A sample without `panes` (a protocol-2 runner) changes nothing.
 *
 * Protocol 3 cannot tell a stopped herdr from a hung one, and -1 also covers a pane list that timed out or did not
 * parse; two samples in a row keep one slow read from counting. While a machine's herdr is down the recovery sweep
 * leaves its lanes alone without spending recovery attempts, and `dori launch --machine <label>` is refused; both
 * read the saved state through `herdrDownSince`, so a `dori` command in another process sees it too.
 */

export type HerdrState = "up" | "down" | "hung";

/** Unreadable samples in a row before a machine's herdr counts as down. */
export const HERDR_DOWN_SAMPLES = 2;

/** A runner's saved herdr state and the supervisor wall time it was entered. */
export type HerdrRecord = { readonly state: HerdrState; readonly since: number };

export type HerdrStore = {
  readonly read: (label: string) => HerdrRecord | undefined;
  readonly save: (label: string, record: HerdrRecord) => void;
};

/** A lead line for one transition, with the journal id it is enqueued under. */
export type HerdrTransition = { readonly id: string; readonly line: string };

const tag = (label: string): string => `machine=${label.replace(/\s/g, "_")}`;

export class HerdrDownInference {
  private readonly misses = new Map<string, number>();
  private readonly instances = new Map<string, string>();

  /** `now` is the supervisor's wall clock: the saved time is read by other processes. */
  constructor(private readonly store: HerdrStore, private readonly now: () => number) {}

  /** The transition a committed runner event shows, if any; it is saved before it is returned. */
  event(label: string, frame: AnyRunnerEvent, proto = 3): HerdrTransition | undefined {
    if (frame.type === "herdr.start") return {
      id: `herdr:${label}:start:${frame.seq}`,
      line: `HERDR_START ${tag(label)} ${frame.body.ok ? "ok" : "failed"} ${frame.body.detail}`,
    };
    const health = frame.type === "herdr.state" ? frame.body : frame.type === "guard.sample" ? frame.body.herdr : undefined;
    if (health) {
      this.misses.delete(label);
      const known = this.store.read(label);
      const instance = this.instances.get(label);
      if (health.instance) this.instances.set(label, health.instance);
      if (known?.state === health.state && !(health.state === "up" && instance && health.instance && instance !== health.instance)) return undefined;
      const since = this.now();
      this.store.save(label, { state: health.state, since });
      if (!known && health.state === "up") return undefined;
      return {
        id: `herdr:${label}:${health.state}:${frame.seq}`,
        line: `HERDR_${health.state.toUpperCase()} ${tag(label)}${health.instance ? ` server=${health.instance.replace(/\s/g, "_")}` : ""} ${health.state === "up" ? "held lane recovery resumes at the next recovery sweep" : "lane recovery on this machine is held until herdr reads again"}`,
      };
    }
    if (proto >= 4) return undefined;
    if (frame.type !== "guard.sample") return undefined;
    const panes = frame.body.panes;
    if (panes === undefined) return undefined;
    const known = this.store.read(label);
    if (panes < 0) {
      const misses = (this.misses.get(label) ?? 0) + 1;
      this.misses.set(label, misses);
      if (misses < HERDR_DOWN_SAMPLES || known?.state === "down") return undefined;
      const since = this.now();
      this.store.save(label, { state: "down", since });
      const refused = label === LOCAL_RUNNER ? "" : ` and dori launch --machine ${label} is refused`;
      return {
        id: `herdr:${label}:down:${since}`,
        line: `HERDR_DOWN ${tag(label)} herdr unreadable in ${misses} guard samples in a row (panes=-1); lane recovery on this machine is held${refused} until herdr reads again`,
      };
    }
    this.misses.delete(label);
    if (known?.state === "up") return undefined;
    const since = this.now();
    this.store.save(label, { state: "up", since });
    if (known?.state !== "down") return undefined;
    return {
      id: `herdr:${label}:up:${since}`,
      line: `HERDR_UP ${tag(label)} herdr reads again (panes=${panes}) after ${Math.max(0, Math.round((since - known.since) / 1000))} s down; held lane recovery resumes at the next recovery sweep`,
    };
  }
}

/** The runners whose machine's herdr is saved as down, with the time it went down (read-only; empty without a hub). */
export const herdrDownSince = (stateDir: string): ReadonlyMap<string, number> =>
  new Map(readRunnerRows(stateDir).flatMap((row) => (row.herdr === "down" || row.herdr === "hung" ? [[row.label, row.herdrSince ?? 0] as const] : [])));
