import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { defaultConfig, fill, leadCommand, leadModels, loadConfig, providerOf } from "../src/config.ts";
import { withState } from "./fakes.ts";

const state = withState();
afterEach(() => {
  delete process.env.DORI_STATE_DIR;
});

test("the shipped example config loads, with ~ paths expanded and unset fields defaulted", async () => {
  const c = await loadConfig(join(import.meta.dir, "../../references/config.example.json"), "/home/ana");
  expect(c.stateDir).toBe("/home/ana/.dori/state");
  expect(c.defaultCwd).toBe("/home/ana/code/my-project");
  expect(c.closeAfterMin).toBe(5);
  expect(c.guard.diskFreeMinGb).toBe(50);
  expect(c.leadDiet).toBe(true);
});

test("leadDiet defaults to true when absent and parses false from the file", async () => {
  const path = join(state.dir, "diet.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 7 }));
  expect((await loadConfig(path, "/home/ana")).leadDiet).toBe(true);
  await Bun.write(path, JSON.stringify({ leadDiet: false }));
  expect((await loadConfig(path, "/home/ana")).leadDiet).toBe(false);
});

test("laneRules defaults to none, keeps trimmed non-blank lines, and refuses anything but an array of strings", async () => {
  const path = join(state.dir, "rules.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 7 }));
  expect((await loadConfig(path, "/home/ana")).laneRules).toEqual([]);
  await Bun.write(path, JSON.stringify({ laneRules: [" Do not merge. ", "  ", "CI runs the typecheck only."] }));
  expect((await loadConfig(path, "/home/ana")).laneRules).toEqual(["Do not merge.", "CI runs the typecheck only."]);
  await Bun.write(path, JSON.stringify({ laneRules: "Do not merge." }));
  await expect(loadConfig(path, "/home/ana")).rejects.toThrow("laneRules must be an array of strings");
});

test("a missing config file falls back to defaults and DORI_STATE_DIR wins over the file", async () => {
  process.env.DORI_STATE_DIR = state.dir;
  const c = await loadConfig("/nonexistent/config.json", "/home/ana");
  expect(c.stateDir).toBe(state.dir);
  expect(c.agentCommand).toEqual(["omo", "--model", "{model}", "{prompt}"]);
});

test("a stray leadModel key in the config file is ignored, and the default model is the subscription one", async () => {
  const path = join(state.dir, "stray.json");
  await Bun.write(path, JSON.stringify({ leadModel: "old/model" }));
  const c = await loadConfig(path, "/home/ana");
  expect(c.defaultModel).toBe("anthropic-subscription/claude-opus-5-5");
  expect(c.laneThinking).toBe("medium");
  expect(c.launchKeywords).toBe("ulw set goal and work");
  expect(c.massLaunchKeywords).toBe("/mass-ulw set goal and work");
});

test("an old config's removed feature flags load fine: the keys are dropped and named in one warning per process", async () => {
  const path = join(state.dir, "old-flags.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 7, operations: false, laneReports: true, superviseTasks: false, store: "json" }));
  // A fresh process, so the once-per-process warning is not already spent by another test file.
  const script = `const { loadConfig } = await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))});
    const a = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    const b = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    console.log(JSON.stringify({ closeAfterMin: a.closeAfterMin, store: b.store, leftover: ["operations", "laneReports", "superviseTasks"].filter((k) => k in a || k in b) }));`;
  const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DORI_STATE_DIR: state.dir } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ closeAfterMin: 7, store: "json", leftover: [] });
  const warnings = err.split("\n").filter((line) => line.startsWith("CONFIG_FLAGS_REMOVED "));
  expect(warnings).toEqual([`CONFIG_FLAGS_REMOVED superviseTasks, operations, laneReports in ${path}: these flags were removed and their behavior is always on; the keys are ignored and can be deleted`]);
});

test("an old config's quotaCheck loads fine: the key is dropped and named in one warning per process", async () => {
  const path = join(state.dir, "old-quota-check.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 9, quotaCheck: ["omo", "auth", "check", "--provider", "{provider}", "--json"] }));
  const script = `const { loadConfig } = await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))});
    const a = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    const b = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    console.log(JSON.stringify({ closeAfterMin: a.closeAfterMin, leftover: ["quotaCheck" in a, "quotaCheck" in b] }));`;
  const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DORI_STATE_DIR: state.dir } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ closeAfterMin: 9, leftover: [false, false] });
  const warnings = err.split("\n").filter((line) => line.startsWith("CONFIG_QUOTA_STALL_KEYS_REMOVED "));
  expect(warnings).toEqual([`CONFIG_QUOTA_STALL_KEYS_REMOVED quotaCheck in ${path}: lanes are no longer checked or paused on quota; the keys are ignored and can be deleted`]);
});

test("an old config's quotaGate loads fine: the key is dropped and named in one warning per process", async () => {
  const path = join(state.dir, "old-quota-gate.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 8, quotaGate: { holdLanesHeadroomPct: 70, holdLanes5hPct: 80, pollMin: 5 } }));
  const script = `const { loadConfig } = await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))});
    const a = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    const b = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    console.log(JSON.stringify({ closeAfterMin: a.closeAfterMin, leftover: ["quotaGate" in a, "quotaGate" in b] }));`;
  const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DORI_STATE_DIR: state.dir } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ closeAfterMin: 8, leftover: [false, false] });
  const warnings = err.split("\n").filter((line) => line.startsWith("CONFIG_QUOTA"));
  expect(warnings).toEqual([`CONFIG_QUOTA_GATE_KEYS_REMOVED quotaGate in ${path}: launches are no longer gated on Claude quota; the keys are ignored and can be deleted`]);
});

test("an old config's delivery.mode loads fine: the key is dropped and named in one warning per process", async () => {
  const path = join(state.dir, "old-delivery-mode.json");
  await Bun.write(path, JSON.stringify({ delivery: { mode: "push", tailMonitor: false } }));
  const script = `const { loadConfig } = await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))});
    const a = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    const b = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    console.log(JSON.stringify({ tailMonitor: a.delivery.tailMonitor, mode: ["mode" in a.delivery, "mode" in b.delivery] }));`;
  const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DORI_STATE_DIR: state.dir } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ tailMonitor: false, mode: [false, false] });
  const warnings = err.split("\n").filter((line) => line.startsWith("CONFIG_DELIVERY_KEYS_REMOVED "));
  expect(warnings).toEqual([`CONFIG_DELIVERY_KEYS_REMOVED delivery.mode in ${path}: push delivery is the only mode; the keys are ignored and can be deleted`]);
});

test("an old config's laneFinishNotice loads fine: the key is dropped and named in one warning per process", async () => {
  const path = join(state.dir, "old-lane-finish.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 6, laneFinishNotice: true }));
  const script = `const { loadConfig } = await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))});
    const a = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    const b = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    console.log(JSON.stringify({ closeAfterMin: a.closeAfterMin, leftover: ["laneFinishNotice" in a, "laneFinishNotice" in b] }));`;
  const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DORI_STATE_DIR: state.dir } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ closeAfterMin: 6, leftover: [false, false] });
  expect(err.split("\n").filter((line) => line.startsWith("CONFIG_"))).toEqual([`CONFIG_OWNER_POST_KEYS_REMOVED laneFinishNotice in ${path}: the supervisor no longer posts lane-finish lines (the lead reports finished lanes); the keys are ignored and can be deleted`]);
});

test("an old config's toodo (the removed Toodo integration) loads fine: the key is dropped and named in one warning per process", async () => {
  const path = join(state.dir, "old-toodo.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 7, toodo: { url: "http://127.0.0.1:1", leadTokenFile: "~/lead-token", discordMirror: { channel: "123" } } }));
  const script = `const { loadConfig } = await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))});
    const a = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    const b = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    console.log(JSON.stringify({ closeAfterMin: a.closeAfterMin, leftover: ["toodo" in a, "toodo" in b] }));`;
  const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DORI_STATE_DIR: state.dir } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ closeAfterMin: 7, leftover: [false, false] });
  expect(err.split("\n").filter((line) => line.startsWith("CONFIG_"))).toEqual([`CONFIG_TOODO_KEYS_REMOVED toodo in ${path}: the Toodo integration was removed (Discord is the only messenger); the keys are ignored and can be deleted`]);
});

test("an old config's task-tracker keys (memoryCheck.toodoMcp/toodoTokenFile, ciToodoWorkspaces) load without error", async () => {
  const path = join(state.dir, "old-tracker.json");
  await Bun.write(path, JSON.stringify({
    memoryCheck: { repo: "~/memory", maxKb: 9, toodoMcp: "http://127.0.0.1:1/mcp", toodoTokenFile: "~/token" },
    ciToodoWorkspaces: { "acme/app": 3 },
  }));
  const c = await loadConfig(path, "/home/ana");
  expect(c.memoryCheck.repo).toBe("/home/ana/memory");
  expect(c.memoryCheck.maxKb).toBe(9);
  expect(c.ciMergeBase).toBe("dev");
});

test("hook templates fill each argument separately, so text with spaces or quotes stays one argument", () => {
  const argv = fill(["notify", "--thread", "{thread}", "--text", "{text}"], { thread: "chat:1/2", text: `it's "done"; rm -rf /` });
  expect(argv).toEqual(["notify", "--thread", "chat:1/2", "--text", `it's "done"; rm -rf /`]);
});

test("leadCommand handles --flag=value templates and a template without --model", () => {
  const config = { ...defaultConfig("/home/test"), defaultModel: "m/lane", leadModel: "m/lead", leadThinking: "high" };
  expect(leadCommand({ ...config, agentCommand: ["omo", "--model={model}", "--thinking=medium", "{prompt}"] }, "@p"))
    .toEqual(["omo", "--model=m/lead", "--thinking=high", "@p"]);
  expect(leadCommand({ ...config, agentCommand: ["omo", "--model={model}", "{prompt}"] }, "@p")).toEqual(["omo", "--model=m/lead", "--thinking", "high", "@p"]);
  expect(leadCommand({ ...config, agentCommand: ["agent", "{prompt}"] }, "@p")).toEqual(["agent", "--thinking", "high", "@p"]);
});

test("the configured lead context cap overrides the default", async () => {
  const local = withState();
  try {
    const path = join(local.dir, "cap.json");
    await Bun.write(path, JSON.stringify({ leadContextCapTokens: 42_000 }));
    const c = await loadConfig(path, "/home/ana");
    expect(c.leadContextCapTokens).toBe(42_000);
  } finally { local.done(); }
});

test("a single lead model uses its own thinking before the shared default", () => {
  const base = { ...defaultConfig("/home/test"), defaultModel: "m/lane", leadThinking: "low" };
  expect(leadModels({ ...base, leadModel: { model: " m/lead ", thinking: "high" } })).toEqual([{ model: "m/lead", thinking: "high" }]);
  expect(leadModels({ ...base, leadModel: "m/lead" })).toEqual([{ model: "m/lead", thinking: "low" }]);
  expect(leadModels({ ...base, leadModel: " " })).toEqual([{ model: "m/lane", thinking: "low" }]);
  expect(leadCommand({ ...base, leadModel: { model: "m/lead", thinking: "high" } }, "@p")).toEqual(["omo", "--model", "m/lead", "--thinking", "high", "@p"]);
  expect(providerOf("opengateway/deepseek/x")).toBe("opengateway");
  expect(providerOf("bare-model")).toBeUndefined();
});

test("old lead controls are ignored and legacy arrays select only the first valid entry, warning once", async () => {
  const path = join(state.dir, "old-lead.json");
  const removed = ["leadEmergencyModels", "leadPrimaryRetryMin", "leadQuotaBusySwitchMin", "leadPrimaryReturnChecks"];
  await Bun.write(path, JSON.stringify({ ...Object.fromEntries(removed.map((key) => [key, 0])), leadModel: [null, " ", { model: " a/one ", thinking: "high" }, "b/two"], leadThinking: "low" }));
  const script = `const { loadConfig, leadModels } = await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))});
    const a = await loadConfig(${JSON.stringify(path)});
    const b = await loadConfig(${JSON.stringify(path)});
    console.log(JSON.stringify({ models: leadModels(a), model: b.leadModel, leftover: ${JSON.stringify(removed)}.filter((key) => key in a || key in b) }));`;
  const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DORI_STATE_DIR: state.dir } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ models: [{ model: "a/one", thinking: "high" }], model: { model: "a/one", thinking: "high" }, leftover: [] });
  expect(err.split("\n").filter((line) => line.startsWith("CONFIG_QUOTA_KEYS_REMOVED "))).toHaveLength(1);
  expect(err.split("\n").filter((line) => line.startsWith("CONFIG_LEAD_CHAIN_REMOVED "))).toHaveLength(1);
});

test("legacy arrays with no usable entry fall back to the lane model", async () => {
  const path = join(state.dir, "empty-lead.json");
  await Bun.write(path, JSON.stringify({ leadModel: [null, " ", {}], defaultModel: "m/default", leadThinking: "low" }));
  expect(leadModels(await loadConfig(path))).toEqual([{ model: "m/default", thinking: "low" }]);
});

test("placement defaults to local with no workspace rules or fallback", async () => {
  expect(defaultConfig("/home/ana").placement).toEqual({ defaultMachine: "local", workspaces: {}, fallback: [] });
  const path = join(state.dir, "placement-none.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 7 }));
  expect((await loadConfig(path, "/home/ana")).placement).toEqual({ defaultMachine: "local", workspaces: {}, fallback: [] });
});

test("placement parses trimmed machines, drops blank workspace values, and blank defaultMachine means local", async () => {
  const path = join(state.dir, "placement.json");
  await Bun.write(path, JSON.stringify({ placement: { defaultMachine: " big ", workspaces: { "/data/repos": " mini ", "acme/app": "", "*": 3 }, fallback: [" mini ", "big"] } }));
  expect((await loadConfig(path, "/home/ana")).placement).toEqual({ defaultMachine: "big", workspaces: { "/data/repos": "mini" }, fallback: ["mini", "big"] });
  await Bun.write(path, JSON.stringify({ placement: { defaultMachine: "  " } }));
  expect((await loadConfig(path, "/home/ana")).placement).toEqual({ defaultMachine: "local", workspaces: {}, fallback: [] });
});

test("placement refuses a non-object and a malformed fallback", async () => {
  const path = join(state.dir, "placement-bad.json");
  for (const placement of ["big", ["big"], null]) {
    await Bun.write(path, JSON.stringify({ placement }));
    await expect(loadConfig(path, "/home/ana")).rejects.toThrow("placement must be an object");
  }
  for (const fallback of ["big", ["big", " "], [1]]) {
    await Bun.write(path, JSON.stringify({ placement: { fallback } }));
    await expect(loadConfig(path, "/home/ana")).rejects.toThrow("placement.fallback must be an array of machine names");
  }
});
