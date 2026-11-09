import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EVENT_LOG, take, unreadAfterAck, writeCursorFile } from "../src/inbox.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const OWNER = "discord:123:5";
const logLine = (id: string, text: string): string => `${JSON.stringify({ id, line: text })}\n`;

/** A state dir (home/state, as the CLI sees it) with the supervisor cursor at 0 and one unseen owner message in 123. */
const world = (): { home: string; stateDir: string } => {
  const s = withState();
  cleanups.push(s.done);
  const stateDir = join(s.dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeCursorFile(stateDir, 0);
  appendFileSync(join(stateDir, EVENT_LOG), logLine(OWNER, "INBOUND 123 5 owner one more thing"));
  return { home: s.dir, stateDir };
};

const run = async (home: string, extra: string[]) => {
  const preload = join(home, "fake-fetch.js");
  writeFileSync(preload, 'globalThis.fetch = async (_u, init) => { console.log("FAKE_BODY " + init.body); return new Response(JSON.stringify({ id: "1" }), { status: 200 }); };');
  const child = Bun.spawn(["bun", "--preload", preload, join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "123", "--text", "x", ...extra], {
    env: { PATH: process.env.PATH ?? "", HOME: home, DORI_CONFIG: join(home, "missing.json"), DORI_STATE_DIR: join(home, "state"), DORI_DISCORD_TOKEN: "t" },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
};

test("send refuses a new post while an unseen owner message waits in the destination, prints it, and a resend then goes through", async () => {
  const { home } = world();
  const refused = await run(home, []);
  expect(refused.code).toBe(3);
  expect(refused.out).toBe("SEND_STALE 1\nUNREAD 123 INBOUND discord:123:5 owner one more thing\n");
  expect(refused.out).not.toContain("FAKE_BODY");
  // SEND_STALE showed it, so it counts as seen now.
  const again = await run(home, []);
  expect(again.code).toBe(0);
  expect(again.out).toContain("SENT 1");
});

test("an owner message in another channel does not make the destination stale", async () => {
  const { home, stateDir } = world();
  appendFileSync(join(stateDir, EVENT_LOG), logLine("discord:999:1", "INBOUND 999 1 owner elsewhere"));
  writeCursorFile(stateDir, Buffer.byteLength(logLine(OWNER, "INBOUND 123 5 owner one more thing")));
  expect((await run(home, [])).code).toBe(0);
});

test("an owner event shown by the ack preview is seen, so send is not stale", async () => {
  const { home, stateDir } = world();
  expect(unreadAfterAck(stateDir, [{ channel: "123", message: "4" }])).toEqual(["UNREAD 123 INBOUND discord:123:5 owner one more thing"]);
  const r = await run(home, []);
  expect(r.code).toBe(0);
  expect(r.out).toContain("SENT 1");
});

test("an event cut off by the preview cap stays unseen", async () => {
  const { home, stateDir } = world();
  appendFileSync(join(stateDir, EVENT_LOG), logLine("discord:123:6", "INBOUND 123 6 owner second"));
  expect(unreadAfterAck(stateDir, [{ channel: "123", message: "4" }], 1)).toEqual(["UNREAD 123 INBOUND discord:123:5 owner one more thing", "UNREAD_MORE 123 1"]);
  const r = await run(home, []);
  expect(r.code).toBe(3);
  expect(r.out).toContain("SEND_STALE 1\nUNREAD 123 INBOUND discord:123:6 owner second");
});

test("an event already taken is seen, so send is not stale", async () => {
  const { home, stateDir } = world();
  take(stateDir, { maxBytes: 16_384, now: 1_800_000_000_000 });
  const r = await run(home, []);
  expect(r.code).toBe(0);
  expect(r.out).toContain("SENT 1");
});

test("--edit is never checked", async () => {
  const { home } = world();
  const r = await run(home, ["--edit", "77"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("FAKE_BODY");
});

test("--force posts despite an unseen owner message", async () => {
  const { home } = world();
  const r = await run(home, ["--force"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("SENT 1");
});
