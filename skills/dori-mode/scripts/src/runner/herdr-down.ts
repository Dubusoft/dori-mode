import { readRunnerRows } from "./hub.ts";
import type { AnyRunnerEvent } from "./protocol.ts";

/**
 * Explicit herdr transitions (`herdr.state`, `herdr.start`) and `guard.sample.herdr` snapshots. Each state change is saved
 * on the runner's hub row and returned once as a lead line (`HERDR_DOWN|HUNG|ELEVATED|UP machine=<label>`); the first
 * `up` of a runner with no saved state is saved and says nothing. A sample without `herdr` changes nothing.
 *
 * While a machine's herdr is down the recovery sweep
 * leaves its lanes alone without spending recovery attempts, and `dori launch --machine <label>` is refused; both
 * read the saved state through `herdrDownSince`, so a `dori` command in another process sees it too.
 */

export type HerdrState = "up" | "down" | "hung" | "elevated";

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
  private readonly instances = new Map<string, string>();

  /** `now` is the supervisor's wall clock: the saved time is read by other processes. */
  constructor(private readonly store: HerdrStore, private readonly now: () => number) {}

  /** The transition a committed runner event shows, if any; it is saved before it is returned. */
  event(label: string, frame: AnyRunnerEvent): HerdrTransition | undefined {
    if (frame.type === "herdr.start") return {
      id: `herdr:${label}:start:${frame.seq}`,
      line: `HERDR_START ${tag(label)} ${frame.body.ok ? "ok" : "failed"} ${frame.body.detail}`,
    };
    const health = frame.type === "herdr.state" ? frame.body : frame.type === "guard.sample" ? frame.body.herdr : undefined;
    if (health) {
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
    return undefined;
  }
}

/** The runners whose machine's herdr is saved as down, with the time it went down (read-only; empty without a hub). */
export const herdrDownSince = (stateDir: string): ReadonlyMap<string, number> =>
  new Map(readRunnerRows(stateDir).flatMap((row) => (row.herdr === "down" || row.herdr === "hung" || row.herdr === "elevated" ? [[row.label, row.herdrSince ?? 0] as const] : [])));
