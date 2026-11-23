import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DECISIONS_FILE, readDecisions, updateDecisions } from "../src/decision-store.ts";
import { withState } from "./fakes.ts";

const ordinary = { id: "d2", source: "lead", state: "open", question: "Continue?", options: ["yes", "no"], recommend: 1, reason: "check", waiting: "lane", blocking: true, channel: "c", openedAt: 0 } as const;

let state: ReturnType<typeof withState>;
let errors: string[];
let spy: Mock<typeof console.error>;
beforeEach(() => {
  state = withState();
  errors = [];
  spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
});
afterEach(() => { spy.mockRestore(); state.done(); });

test("a missing decisions.json reads as no decisions without a warning", () => {
  expect(readDecisions(state.dir)).toEqual({ nextSeq: 1, decisions: [] });
  expect(errors).toEqual([]);
});

test("a corrupt decisions.json reads as no decisions, named in one DECISIONS_UNREADABLE line, and writers still refuse it", () => {
  const path = join(state.dir, DECISIONS_FILE);
  writeFileSync(path, "{\"nextSeq\": 3, \"decisions\": [");
  expect(readDecisions(state.dir)).toEqual({ nextSeq: 1, decisions: [] });
  expect(readDecisions(state.dir)).toEqual({ nextSeq: 1, decisions: [] });
  expect(errors).toHaveLength(1);
  expect(errors[0]).toStartWith(`DECISIONS_UNREADABLE ${path}: `);
  expect(() => updateDecisions(state.dir, (file) => ({ file, result: undefined }))).toThrow();
});

test("non-object entries are dropped, named in one DECISIONS_ENTRY_DROPPED line, and the other decisions still read", () => {
  const path = join(state.dir, DECISIONS_FILE);
  writeFileSync(path, JSON.stringify({ nextSeq: 3, decisions: [null, ordinary, "d1", 7] }));
  expect(readDecisions(state.dir)).toEqual({ nextSeq: 3, decisions: [ordinary] });
  expect(readDecisions(state.dir)).toEqual({ nextSeq: 3, decisions: [ordinary] });
  expect(errors).toEqual([`DECISIONS_ENTRY_DROPPED ${path}: entries 0, 2, 3 are not objects and are ignored`]);
  updateDecisions(state.dir, (file) => ({ file: { ...file, nextSeq: 4 }, result: undefined }));
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ nextSeq: 4, decisions: [ordinary] });
});
