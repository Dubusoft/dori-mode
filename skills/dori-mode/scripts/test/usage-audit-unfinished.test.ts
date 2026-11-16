import { afterEach, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { recordHandled } from "../src/ack.ts";
import { EVENT_LOG, readCarried, writeCarried, writeCursorFile } from "../src/inbox.ts";
import { openStore } from "../src/store.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const state = (): string => {
  const s = withState();
  cleanups.push(s.done);
  writeCursorFile(s.dir, 0);
  return s.dir;
};
const inbound = (dir: string, id: string, text: string): void => {
  appendFileSync(join(dir, EVENT_LOG), `${JSON.stringify({ id, line: `INBOUND discord 1 ${text}` })}\n`);
};
const take = async (dir: string): Promise<string> => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "inbox", "take"], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, DORI_CONFIG: join(dir, "missing.json"), DORI_STATE_DIR: dir },
    stdout: "pipe", stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return out;
};

test("a take prints no UNFINISHED reminder for a message in the same take, but still for an earlier one", async () => {
  const dir = state();
  inbound(dir, "discord:1:100", "first");
  const one = await take(dir);
  expect(one).toContain("discord:1:100\tINBOUND discord 1 first");
  expect(one).not.toContain("UNFINISHED");
  expect(readCarried(dir).map((item) => item.id)).toEqual(["discord:1:100"]);

  inbound(dir, "discord:1:101", "second");
  const two = await take(dir);
  expect(two).toContain("discord:1:101\tINBOUND discord 1 second");
  expect(two).toContain("unfinished:discord:1:100\t");
  expect(two).not.toContain("unfinished:discord:1:101");
});

test("recordHandled prunes the carried entry only once the message is fully covered", () => {
  const dir = state();
  const owner = (id: string) => ({ kind: "owner" as const, id, line: `INBOUND discord 1 ${id}` });
  writeCarried(dir, [owner("discord:1:100"), owner("discord:1:200"), { kind: "held", id: "launch-queue:s", line: "held" }]);

  // Two tasks declared, one covered: still unfinished.
  recordHandled(dir, "1", "100", 1, { tasks: 2, reply: true });
  expect(readCarried(dir).map((item) => item.id)).toEqual(["discord:1:100", "discord:1:200", "launch-queue:s"]);
  // The second task lands in a further receipt that the supervisor has not consumed yet.
  recordHandled(dir, "1", "100", 2, { tasks: 2, lanes: ["alpha"] });
  expect(readCarried(dir).map((item) => item.id)).toEqual(["discord:1:200", "launch-queue:s"]);

  recordHandled(dir, "1", "200", 3, { all: true });
  expect(readCarried(dir).map((item) => item.id)).toEqual(["launch-queue:s"]);
});

for (const kind of ["json", "sqlite"] as const) {
  test(`recordHandled counts the coverage the supervisor already consumed (${kind} store)`, () => {
    const dir = state();
    // The supervisor consumed an earlier receipt: three tasks declared, lane alpha linked; its receipt file is gone.
    const store = openStore(dir, kind);
    store.save({ events: [], awaitingAck: [{ id: "discord:1:100", since: 1, ackedAt: 1, tasks: 3, lanes: ["alpha"] }] }, "full");
    store.close?.();
    writeCarried(dir, [{ kind: "owner", id: "discord:1:100", line: "INBOUND discord 1 three things" }]);

    recordHandled(dir, "1", "100", 2, { lanes: ["beta"] });
    expect(readCarried(dir).map((item) => item.id)).toEqual(["discord:1:100"]);
    recordHandled(dir, "1", "100", 3, { lanes: ["gamma"] });
    expect(readCarried(dir)).toEqual([]);
  });
}
