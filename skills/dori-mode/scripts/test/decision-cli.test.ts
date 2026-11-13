import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EVENT_LOG, writeCursorFile } from "../src/inbox.ts";
import { DECISIONS_FILE } from "../src/owner-decisions.ts";
import { Registry } from "../src/registry.ts";

// Each case spawns `bun src/cli.ts`; process startup under a loaded full run outgrows bun's default 5 s.
setDefaultTimeout(30_000);

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "decision-cli-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cli = async (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "no-config.json"), DORI_STATE_DIR: dir, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

const decision = (id: string, state: string, openedAt: number, extra: Record<string, unknown> = {}) => ({
  id, state, question: `question ${id}`, options: ["a", "b"], recommend: 1, reason: "r", waiting: "w", blocking: true,
  source: "lead", channel: "900", thread: `90${id.slice(1)}`, openedAt, ...extra,
});

test("decision list: DECISION_NONE with no decisions; open ones oldest first; --all adds recently closed; --json", async () => {
  const none = await cli(["decision", "list"]);
  expect(none).toMatchObject({ code: 0, out: "DECISION_NONE\n" });
  const now = Date.now();
  writeFileSync(join(dir, DECISIONS_FILE), JSON.stringify({ nextSeq: 4, decisions: [
    decision("d2", "answered", now - 60_000), decision("d1", "open", now - 120_000, { lane: "ap-7-1", task: 7 }),
    decision("d3", "closed", now - 180_000, { closedAt: now - 1_000 }),
  ] }));
  const open = await cli(["decision", "list"]);
  expect(open.code).toBe(0);
  expect(open.out.trim().split("\n").map((line) => line.split(" ")[0])).toEqual(["d1", "d2"]);
  expect(open.out).toContain("d1 open blocking task=#7 lane=ap-7-1");
  const all = await cli(["decision", "list", "--all"]);
  expect(all.out.trim().split("\n").map((line) => line.split(" ")[0])).toEqual(["d3", "d1", "d2"]);
  const json = await cli(["decision", "list", "--json"]);
  expect((JSON.parse(json.out) as { id: string }[]).map((d) => d.id)).toEqual(["d1", "d2"]);
});

test("decision list shows a direct answer's newest revision and where its delivery stands", async () => {
  const now = Date.now();
  const target = { lane: "ap-7-1", runner: "local", generation: 0 };
  const revision = (rev: number, choice: number | undefined, state: string) => ({
    rev, channel: "901", message: "7", edit: rev - 1, hash: "h", ...(choice !== undefined ? { choice } : {}), target, at: now,
    delivery: { id: `decision-d1-r${rev}`, state, updatedAt: now },
  });
  writeFileSync(join(dir, DECISIONS_FILE), JSON.stringify({ nextSeq: 3, decisions: [
    decision("d1", "open", now - 60_000, { source: "lane", lane: "ap-7-1", target, revisions: [revision(1, 1, "superseded"), revision(2, 2, "queued")] }),
    decision("d2", "open", now - 30_000, { source: "lane", lane: "ap-7-1", target, revisions: [revision(1, undefined, "cancelled")] }),
  ] }));
  const r = await cli(["decision", "list"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("d1 open blocking lane=ap-7-1 answer=r2:2 delivery=queued age=");
  expect(r.out).toContain("d2 open blocking lane=ap-7-1 answer=r1:withdrawn delivery=cancelled age=");
});

test("decision open refuses bad input with DECISION_REFUSED and a usage line (exit 2), before any token is needed", async () => {
  const base = ["decision", "open", "--question", "q", "--recommend", "1", "--reason", "r", "--waiting", "w"];
  for (const [extra, reason] of [
    [["--option", "a"], "DECISION_REFUSED needs 2-9 --option values, got 1"],
    [["--option", "a", "--option", "b", "--task", "x"], "DECISION_REFUSED --task must be a positive integer"],
    [["--option", "a", "--option", "b", "--lane", "nope"], "DECISION_REFUSED unknown --lane nope"],
  ] as const) {
    const r = await cli([...base, ...extra]);
    expect(r.code).toBe(2);
    expect(r.err).toStartWith(reason);
    expect(r.err).toContain("usage: dori decision open");
  }
  const noToken = await cli([...base, "--option", "a", "--option", "b", "--no-origin"]);
  expect(noToken.code).toBe(1);
  expect(noToken.err).toContain("DORI_DISCORD_TOKEN is not set");
});

test("a lead decision with no origin thread is refused unless --no-origin says so (exit 2), before any token is needed", async () => {
  const base = ["decision", "open", "--question", "q", "--option", "a", "--option", "b", "--recommend", "1", "--reason", "r", "--waiting", "w"];
  const none = await cli(base);
  expect(none.code).toBe(2);
  expect(none.err).toStartWith("DECISION_REFUSED no origin: pass --thread REF (the thread the question came from) or --no-origin\n");
  await new Registry(dir).write({ key: "ap-7-1", title: "t", brief: "b", done: "d", thread: "none", status: "working" } as never);
  expect((await cli([...base, "--lane", "ap-7-1"])).err).toStartWith("DECISION_REFUSED no origin");
  expect((await cli([...base, "--no-origin", "--thread", "discord:1/2"])).err).toStartWith("DECISION_REFUSED --no-origin cannot go with --thread");
});

test("decision open --request refuses options and a long-lived secret without --file (exit 2), before any token is needed", async () => {
  const base = ["decision", "open", "--request", "--reason", "r", "--waiting", "w"];
  for (const [extra, reason] of [
    [["--question", "login code", "--option", "a"], "DECISION_REFUSED a --request takes no --option or --recommend"],
    [["--question", "the npm API token"], "DECISION_REFUSED a long-lived secret"],
    [["--question", "the npm API token", "--file", "secrets/npm"], "DECISION_REFUSED --file must be an absolute"],
  ] as const) {
    const r = await cli([...base, ...extra]);
    expect(r.code).toBe(2);
    expect(r.err).toStartWith(reason);
  }
  const noToken = await cli([...base, "--question", "the npm API token", "--file", "~/.config/npm-token", "--thread", "discord:1/2"]);
  expect(noToken.code).toBe(1);
  expect(noToken.err).toContain("DORI_DISCORD_TOKEN is not set");
});

test("decision close: unknown, already closed and out-of-range choice exit 2 without touching Discord", async () => {
  writeFileSync(join(dir, DECISIONS_FILE), JSON.stringify({ nextSeq: 3, decisions: [
    decision("d1", "open", Date.now()), decision("d2", "closed", Date.now(), { closedAt: Date.now() }),
  ] }));
  expect(await cli(["decision", "close", "d9", "--text", "x"])).toMatchObject({ code: 2, err: "DECISION_UNKNOWN d9\n" });
  expect(await cli(["decision", "close", "d2", "--text", "x"])).toMatchObject({ code: 2, err: "DECISION_ALREADY_CLOSED d2\n" });
  expect((await cli(["decision", "close", "d1", "--text", "x", "--choice", "3"])).err).toStartWith("DECISION_BAD_CHOICE d1");
  expect((await cli(["decision", "close", "d1"])).code).toBe(2);
});

test("decision close refuses with DECISION_STALE and the unread lines (exit 3) while an owner message in the thread is unseen, then goes on", async () => {
  writeFileSync(join(dir, DECISIONS_FILE), JSON.stringify({ nextSeq: 2, decisions: [decision("d1", "open", Date.now())] }));
  writeCursorFile(dir, 0);
  appendFileSync(join(dir, EVENT_LOG), `${JSON.stringify({ id: "discord:901:7", line: "INBOUND 901 7 also do X" })}\n`);
  const stale = await cli(["decision", "close", "d1", "--text", "x", "--choice", "1"]);
  expect(stale).toMatchObject({ code: 3, out: "DECISION_STALE 1\nUNREAD 901 INBOUND discord:901:7 also do X\n" });
  // Printed once, it counts as seen: the next close goes on to Discord (no token here).
  const again = await cli(["decision", "close", "d1", "--text", "x", "--choice", "1"]);
  expect(again.code).toBe(1);
  expect(again.err).toContain("DORI_DISCORD_TOKEN is not set");
  expect((await cli(["decision", "close", "d1", "--text", "x", "--tasks", "0"])).code).toBe(2);
});

test("a pane registered to a lane is refused decision with LANE_PERMISSION_DENIED (exit 1)", async () => {
  await new Registry(dir).write({ key: "ap-7-1", title: "t", brief: "b", done: "d", thread: "discord:1/2", pane: "w:p9", status: "working" } as never);
  const r = await cli(["decision", "list"], { HERDR_PANE_ID: "w:p9" });
  expect(r.code).toBe(1);
  expect(r.err).toStartWith("LANE_PERMISSION_DENIED lane ap-7-1 may not run decision; it is lead-only.");
});
