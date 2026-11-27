import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { CONFIG_FILE_KEYS, loadConfig } from "../src/config.ts";
import { CONFIG_SCHEMA_VERSION, migrateConfigSchema } from "../src/config-schema.ts";
import { readDecisions, updateDecisions } from "../src/decision-store.ts";
import { withState } from "./fakes.ts";

test("schema 8 drops the old secrets key and preserves secretCommands", async () => {
  const raw = { schemaVersion: 7, secrets: { TOKEN: { lanes: ["lane-a"] } }, secretCommands: {} };
  const migrated = migrateConfigSchema(raw);
  expect(CONFIG_SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
  const fresh = migrateConfigSchema({});
  expect(fresh.next).not.toHaveProperty("secrets");
  expect(fresh.filled).not.toContain("secrets");
  expect(fresh.dropped.map(([key]) => key)).not.toContain("secrets");
  expect(migrated.next).toEqual({ secretCommands: {} });
  expect(migrated.dropped.map(([key]) => key)).toEqual(["secrets"]);
  expect(CONFIG_FILE_KEYS as readonly string[]).not.toContain("secrets");
  const state = withState();
  try {
    const path = join(state.dir, "config.json");
    writeFileSync(path, JSON.stringify(raw));
    const loaded = await loadConfig(path, state.dir);
    expect(loaded).not.toHaveProperty("secrets");
    expect(loaded.secretCommands).toEqual({});
  } finally { state.done(); }
});

test("old pending and opened credential decisions are dropped while ordinary state loads", () => {
  const state = withState();
  try {
    const path = join(state.dir, "decisions.json");
    const ordinary = { id: "d2", source: "lead", state: "open", question: "Continue?", options: ["yes", "no"], recommend: 1, reason: "check", waiting: "lane", blocking: true, channel: "c", openedAt: 0 } as const;
    writeFileSync(path, JSON.stringify({ nextSeq: 3, decisions: [{ id: "d1", secretRequest: { names: ["TOKEN"] } }, ordinary], secretRequests: [{ lane: "lane-a", names: ["TOKEN"] }] }));
    expect(readDecisions(state.dir)).toEqual({ nextSeq: 3, decisions: [ordinary] });
    updateDecisions(state.dir, (file) => ({ file: { ...file, nextSeq: 4 }, result: undefined }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ nextSeq: 4, decisions: [ordinary] });
  } finally { state.done(); }
});
