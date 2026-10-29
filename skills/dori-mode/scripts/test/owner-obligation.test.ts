import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EVENT_LOG, pendingTakes, readCarried, take, takeCarriedReminders, writeCursorFile } from "../src/inbox.ts";
import { withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

test.each([
  ["discord:1:2", "INBOUND 1 2 owner text"],
  ["discord:1:2:edit:1000", "INBOUND_EDIT 1 2 revised text"],
])("receipt-before-print death leaves owner text readable on the next take: %s", async (id, line) => {
  const state = withState();
  cleanups.push(state.done);
  writeCursorFile(state.dir, 0);
  writeFileSync(join(state.dir, EVENT_LOG), [
    { id, line },
    { id: "lane:alpha", line: "LANE_CLOSED alpha merged" },
  ].map((event) => JSON.stringify(event) + "\n").join(""));
  // This is the CLI boundary: take has durably written its receipt, but no output function ran.
  const child = Bun.spawn([process.execPath, "-e",
    `import { take } from ${JSON.stringify(join(import.meta.dir, "../src/inbox.ts"))};
     take(${JSON.stringify(state.dir)}, { maxBytes: 16384, now: 1000 });
     process.exit(71);`,
  ], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code).toBe(71);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
  expect(pendingTakes(state.dir)).toHaveLength(1);
  expect(take(state.dir, { maxBytes: 16_384, now: 1001 }).events).toEqual([]);
  expect(takeCarriedReminders(state.dir).join("\n")).toContain(line);
  expect(readCarried(state.dir)).toEqual([{ kind: "owner", id, line }]);
});

test("failure to preserve owner text cannot publish a take receipt", () => {
  const state = withState();
  cleanups.push(state.done);
  writeCursorFile(state.dir, 0);
  writeFileSync(join(state.dir, EVENT_LOG), JSON.stringify({ id: "discord:1:2", line: "INBOUND 1 2 text" }) + "\n");
  mkdirSync(join(state.dir, `carried.json.${process.pid}.tmp`));
  expect(() => take(state.dir, { maxBytes: 16_384, now: 1000 })).toThrow();
  expect(pendingTakes(state.dir)).toEqual([]);
});

test("peek writes neither a receipt nor owner recovery reminders", () => {
  const state = withState();
  cleanups.push(state.done);
  writeCursorFile(state.dir, 0);
  writeFileSync(join(state.dir, EVENT_LOG), JSON.stringify({ id: "discord:1:2", line: "INBOUND 1 2 text" }) + "\n");
  expect(take(state.dir, { maxBytes: 16_384, now: 1000, peek: true }).events).toHaveLength(1);
  expect(pendingTakes(state.dir)).toEqual([]);
  expect(readCarried(state.dir)).toEqual([]);
});
