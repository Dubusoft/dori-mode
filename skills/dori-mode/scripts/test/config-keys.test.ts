import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigKeyError, configureKeys, type ConfigureOptions, DORI_CONFIG_KEYS, doriConfigDefault, formatValue, KEY_INPUT_HINT, type KeyPrompter, type KeySpec, parseSetArgs, parseValue,
  pruneDoriConfig, pruneRunnerConfig, readSeenKeys, RUNNER_CONFIG_KEYS, writeSeenKeys,
} from "../src/config-keys.ts";
import { CONFIG_FILE_KEYS } from "../src/config.ts";
import { RUNNER_POLICY_KEYS } from "../src/runner/policy.ts";

const specOf = (specs: readonly KeySpec[], key: string): KeySpec => specs.find((s) => s.key === key)!;
const dori = (key: string) => specOf(DORI_CONFIG_KEYS, key);
const runner = (key: string) => specOf(RUNNER_CONFIG_KEYS, key);

test("the spec lists match the keys each file reads, in order", () => {
  expect(DORI_CONFIG_KEYS.map((s) => s.key)).toEqual([...CONFIG_FILE_KEYS]);
  expect(RUNNER_CONFIG_KEYS.map((s) => s.key)).toEqual([...RUNNER_POLICY_KEYS]);
  expect(DORI_CONFIG_KEYS.filter((s) => s.required).map((s) => s.key).sort()).toEqual(["defaultCwd", "defaultModel", "discord", "discordChannels", "stateDir"]);
  expect(RUNNER_CONFIG_KEYS.filter((s) => s.required).map((s) => s.key)).toEqual(["agents", "allowedRoots"]);
});

test("pruneDoriConfig drops what loadConfig no longer reads and keeps the rest in order", () => {
  const raw = {
    stateDir: "~/.dori/state", memoryCheck: { enabled: true }, sessionsDir: "/x", store: "sqlite",
    hooks: { threadReply: ["a"], threadDone: ["b"] }, laneSandbox: { command: ["lane-sandbox"], default: true },
    runners: { listen: "0.0.0.0", mac: { allowUnsandboxed: true } }, discordChannels: ["1"],
  };
  const before = JSON.stringify(raw);
  const { next, removed } = pruneDoriConfig(raw);
  expect(JSON.stringify(raw)).toBe(before);
  expect(next).toEqual({ stateDir: "~/.dori/state", hooks: { threadReply: ["a"] }, laneSandbox: { command: ["lane-sandbox"] }, runners: { mac: { allowUnsandboxed: true } }, discordChannels: ["1"] });
  expect(Object.keys(next)).toEqual(["stateDir", "hooks", "laneSandbox", "runners", "discordChannels"]);
  expect(removed).toEqual(["memoryCheck", "sessionsDir", "store", "hooks.threadDone", "laneSandbox.default", "runners.listen"]);
  expect(pruneDoriConfig({ runners: [{ label: "a" }] })).toEqual({ next: {}, removed: ["runners"] });
});

test("pruneRunnerConfig drops unknown top keys and guard subkeys", () => {
  const { next, removed } = pruneRunnerConfig({ agents: {}, bogus: 1, guard: { loadAlert: 4, foo: 2 } });
  expect(next).toEqual({ agents: {}, guard: { loadAlert: 4 } });
  expect(removed).toEqual(["bogus", "guard.foo"]);
});

test("parseValue reads each kind and names the key on bad input", () => {
  expect(parseValue(dori("discordChannels"), " 1, 2 ,,3 ")).toEqual(["1", "2", "3"]);
  expect(parseValue(dori("agentCommand"), '["omo", "--model"]')).toEqual(["omo", "--model"]);
  expect(() => parseValue(dori("agentCommand"), "[oops")).toThrow(ConfigKeyError);
  expect(parseValue(dori("discord"), '{"ownerId":"1"}')).toEqual({ ownerId: "1" });
  expect(() => parseValue(dori("discord"), "{bad")).toThrow(/discord must be JSON/);
  expect(parseValue(runner("detectWorkspaces"), "YES")).toBe(true);
  expect(parseValue(runner("detectWorkspaces"), "false")).toBe(false);
  expect(() => parseValue(runner("detectWorkspaces"), "maybe")).toThrow(/detectWorkspaces must be true\|false/);
  expect(parseValue(runner("sandbox"), "required")).toBe("required");
  expect(() => parseValue(runner("jobs"), "sometimes")).toThrow(/jobs must be one of allow\|deny/);
  expect(parseValue(dori("defaultModel"), "  a/b  ")).toBe("a/b");
  expect(parseValue(dori("leadModel"), '{"model":"a/b","thinking":"high"}')).toEqual({ model: "a/b", thinking: "high" });
  expect(parseValue(dori("leadModel"), "[not json")).toBe("[not json");
});

test("parseSetArgs splits at the first =, treats an empty value as unset, and refuses bad keys and conflicts", () => {
  expect(parseSetArgs(DORI_CONFIG_KEYS, ["defaultModel=a/b=c", "discordChannels=1,2", "alertsChannel="], ["ownerLanguage"]))
    .toEqual({ patch: { defaultModel: "a/b=c", discordChannels: ["1", "2"] }, unset: ["alertsChannel", "ownerLanguage"] });
  expect(() => parseSetArgs(DORI_CONFIG_KEYS, ["memoryCheck=1"], [])).toThrow(/unknown key memoryCheck.*valid keys: discord, stateDir/);
  expect(() => parseSetArgs(DORI_CONFIG_KEYS, ["defaultModel"], [])).toThrow(ConfigKeyError);
  expect(() => parseSetArgs(DORI_CONFIG_KEYS, [], ["nope"])).toThrow(/unknown key nope/);
  expect(() => parseSetArgs(DORI_CONFIG_KEYS, ["defaultModel=x"], ["defaultModel"])).toThrow(/both set and unset/);
  expect(() => parseSetArgs(RUNNER_CONFIG_KEYS, ["jobs=maybe"], [])).toThrow(ConfigKeyError);
});

test("formatValue shows lists comma joined and other values as compact JSON", () => {
  expect(formatValue(dori("ownerLanguage"), undefined)).toBe("");
  expect(formatValue(dori("discordChannels"), ["1", "2"])).toBe("1,2");
  expect(formatValue(dori("discord"), { ownerId: "1" })).toBe('{"ownerId":"1"}');
  expect(formatValue(runner("detectWorkspaces"), false)).toBe("false");
});

type Script = { answers: string[]; confirms: boolean[]; asked: string[]; confirmed: string[] };

/** Answers in order; Enter (the current value) when an answer is undefined; throws when asked more than scripted. */
const scripted = (answers: (string | undefined)[], confirms: boolean[] = []): KeyPrompter & { s: Script } => {
  const s: Script = { answers: [], confirms: [...confirms], asked: [], confirmed: [] };
  let i = 0;
  return {
    s,
    ask: async (question, current) => {
      s.asked.push(question.split(" ")[0]!);
      if (i >= answers.length) throw new Error(`unexpected question ${question}`);
      const a = answers[i++];
      return a === undefined ? current : a;
    },
    confirm: async (question) => {
      s.confirmed.push(question);
      const c = s.confirms.shift();
      if (c === undefined) throw new Error(`unexpected confirm ${question}`);
      return c;
    },
  };
};

const SPECS: readonly KeySpec[] = [
  { key: "name", required: true, kind: "string", describe: "Name" },
  { key: "roots", required: true, kind: "list", describe: "Roots" },
  { key: "mode", required: false, kind: "enum", values: ["a", "b"], describe: "Mode" },
  { key: "extra", required: false, kind: "json", describe: "Extra" },
  { key: "lead", required: false, kind: "string", describe: "Lead" },
];

const HINT = `SETUP_KEYS_HINT ${KEY_INPUT_HINT}`;

const run = (prompt: KeyPrompter, o: Partial<ConfigureOptions>) => {
  const lines: string[] = [];
  const result = configureKeys({ specs: SPECS, current: {}, patch: {}, unset: [], prompt, interactive: true, seen: new Set(), mode: "full", log: (l) => lines.push(l), ...o });
  return result.then((r) => ({ ...r, lines }));
};

test("patch and unset keys are applied, logged and never asked", async () => {
  const p = scripted([undefined, undefined, undefined], [false]);
  const r = await run(p, { current: { name: "x", lead: "old", extra: { a: 1 } }, patch: { name: "y", mode: "a" }, unset: ["lead"], seen: new Set(["extra"]) });
  expect(p.s.asked).toEqual(["roots"]);
  expect(p.s.confirmed).toEqual(["Edit the other optional keys too?"]);
  expect(r.next).toEqual({ name: "y", extra: { a: 1 }, mode: "a" });
  expect(r.lines).toEqual(["SETUP_KEY_SET name", "SETUP_KEY_SET mode", "SETUP_KEY_UNSET lead", HINT]);
  expect([...r.shown].sort()).toEqual(["lead", "mode", "name", "roots"]);
  expect(r.missingRequired).toEqual(["roots"]);
});

test("mode new asks only unseen keys and required keys without a value", async () => {
  const p = scripted(["/r", "b"]);
  const r = await run(p, { mode: "new", current: { name: "x", extra: {}, lead: "l" }, seen: new Set(["name", "roots", "extra", "lead"]) });
  expect(p.s.asked).toEqual(["roots", "mode"]);
  expect(p.s.confirmed).toEqual([]);
  expect(r.next).toEqual({ name: "x", extra: {}, lead: "l", roots: ["/r"], mode: "b" });
  expect(r.missingRequired).toEqual([]);
});

test("mode full asks required and unseen keys, then the others only after the confirm", async () => {
  const seen = new Set(["name", "roots", "mode", "extra"]);
  const declined = scripted([undefined, undefined, undefined], [false]);
  await run(declined, { current: { name: "x", roots: ["/r"] }, seen });
  expect(declined.s.asked).toEqual(["name", "roots", "lead"]);
  const accepted = scripted([undefined, undefined, undefined, "a", '{"k":true}'], [true]);
  const r = await run(accepted, { current: { name: "x", roots: ["/r"] }, seen });
  expect(accepted.s.asked).toEqual(["name", "roots", "lead", "mode", "extra"]);
  expect(r.next).toEqual({ name: "x", roots: ["/r"], mode: "a", extra: { k: true } });
  const none = scripted(Array(5).fill(undefined));
  await run(none, { current: { name: "x", roots: ["/r"] } });
  expect(none.s.confirmed).toEqual([]);
});

test("- deletes an optional key, is refused for a required one, and an invalid answer is asked again", async () => {
  const p = scripted(["-", undefined, "/a, /b", "c", "-", undefined, "-"], [true]);
  const r = await run(p, { current: { name: "x", mode: "a", lead: "l" }, seen: new Set(["mode", "extra", "lead"]) });
  expect(p.s.asked).toEqual(["name", "name", "roots", "mode", "mode", "extra", "lead"]);
  expect(r.next).toEqual({ name: "x", roots: ["/a", "/b"] });
  expect(r.lines).toEqual([
    HINT,
    "SETUP_KEY_REQUIRED name: it cannot be cleared",
    "SETUP_KEY_SET roots",
    "SETUP_KEY_INVALID mode: mode must be one of a|b",
    "SETUP_KEY_UNSET mode",
    "SETUP_KEY_UNSET lead",
  ]);
});

test("Enter keeps a legacy array value byte-identical", async () => {
  const legacy = [{ model: "a/b", thinking: "high" }, "c/d"];
  const p = scripted([undefined, undefined, undefined], [false]);
  const r = await run(p, { current: { name: "x", roots: ["/r"], lead: legacy }, seen: new Set(["name", "roots", "mode", "extra"]) });
  expect(p.s.asked).toContain("lead");
  expect(r.next.lead).toBe(legacy);
  expect(r.lines).toEqual([HINT]);
});

test("a key without a value shows its effective default, and hinted callers get no second hint", async () => {
  const questions: string[] = [];
  const prompt: KeyPrompter = { ask: async (q, current) => { questions.push(q); return current; }, confirm: async () => false };
  const lines: string[] = [];
  await configureKeys({
    specs: DORI_CONFIG_KEYS.filter((s) => ["worktreeRoot", "alertsChannel", "leadModel"].includes(s.key)),
    current: { discordChannels: ["123"], defaultModel: "p/m", leadModel: "p/lead" }, patch: {}, unset: [], prompt, interactive: true,
    seen: new Set(), mode: "full", defaults: doriConfigDefault("/h"), hinted: true, log: (l) => lines.push(l),
  });
  expect(questions.find((q) => q.startsWith("worktreeRoot "))).toEndWith("(default: /data/repos/worktrees)");
  expect(questions.find((q) => q.startsWith("alertsChannel "))).toEndWith("(default: 123)");
  expect(questions.find((q) => q.startsWith("leadModel "))).not.toContain("(default:");
  expect(lines).toEqual([]);
});

test("non-interactive asks nothing and reports required keys without a value", async () => {
  const p = scripted([]);
  const r = await run(p, { interactive: false, current: { name: "", roots: [] }, patch: { lead: "l" }, skip: ["name"] });
  expect(p.s.asked).toEqual([]);
  expect(r.missingRequired).toEqual(["name", "roots"]);
  expect(r.shown).toEqual(["lead"]);
});

test("seen keys round trip through a sorted 0600 file; missing or malformed reads as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "config-keys-"));
  try {
    const path = join(dir, "nested", "seen.json");
    expect(readSeenKeys(path).size).toBe(0);
    writeSeenKeys(path, ["b", "a", "b"]);
    expect(readFileSync(path, "utf8")).toBe('["a","b"]\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect([...readSeenKeys(path)]).toEqual(["a", "b"]);
    writeFileSync(path, "{not json");
    expect(readSeenKeys(path).size).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
