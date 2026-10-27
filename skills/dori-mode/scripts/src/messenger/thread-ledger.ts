import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export const tsAfter = (a: string, b: string): boolean => Number(a) > Number(b);

export type LedgerThread = { readonly channel: string; readonly rootTs: string; readonly seenTs: string };

export class ThreadLedger {
  private threads = new Map<string, LedgerThread>();
  private loaded = false;
  private batching = false;
  private dirty = false;

  constructor(private readonly file: string) {}

  private key(channel: string, rootTs: string): string {
    return `${channel}:${rootTs}`;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const f = Bun.file(this.file);
    if (await f.exists()) for (const t of (await f.json()) as LedgerThread[]) this.threads.set(this.key(t.channel, t.rootTs), t);
    this.loaded = true;
  }

  /** Defers disk writes until flush(); mutations only mark the ledger dirty. */
  beginBatch(): void {
    this.batching = true;
  }

  /** Ends a batch and writes the file at most once, only if it changed. */
  async flush(): Promise<void> {
    this.batching = false;
    if (this.dirty) await this.save();
  }

  private async persist(): Promise<void> {
    this.dirty = true;
    if (!this.batching) await this.save();
  }

  private async save(): Promise<void> {
    this.dirty = false;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await Bun.write(tmp, JSON.stringify([...this.threads.values()], null, 1));
    renameSync(tmp, this.file);
  }

  async record(channel: string, rootTs: string, postedTs: string): Promise<void> {
    await this.load();
    const k = this.key(channel, rootTs);
    const prev = this.threads.get(k);
    const seenTs = prev && tsAfter(prev.seenTs, postedTs) ? prev.seenTs : postedTs;
    this.threads.set(k, { channel, rootTs, seenTs });
    await this.persist();
  }

  async markSeen(channel: string, rootTs: string, ts: string): Promise<void> {
    await this.load();
    const prev = this.threads.get(this.key(channel, rootTs));
    if (!prev || !tsAfter(ts, prev.seenTs)) return;
    this.threads.set(this.key(channel, rootTs), { ...prev, seenTs: ts });
    await this.persist();
  }

  async list(): Promise<LedgerThread[]> {
    await this.load();
    return [...this.threads.values()];
  }
}
