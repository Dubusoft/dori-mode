import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { alertsChannelOf, defaultConfig, fill, leadCommand, leadModels, loadConfig, providerOf } from "../src/config.ts";
import { withState } from "./fakes.ts";
import { BUILT_IN } from "../src/tunables.ts";

const state = withState();
afterEach(() => {
  delete process.env.DORI_STATE_DIR;
});

test("the shipped example config loads, with ~ paths expanded and unset fields defaulted", async () => {
  const c = await loadConfig(join(import.meta.dir, "../../references/config.example.json"), "/home/ana");
  expect(c.stateDir).toBe("/home/ana/.dori/state");
  expect(c.leadCwd).toBe("/home/ana/code/my-project");
  expect(c.guard.diskFreeMinGb).toBe(50);
});

test("leadCwd defaults to ~/.dori/lead; the legacy defaultCwd is read only while leadCwd is absent", async () => {
  const path = join(state.dir, "lead-cwd.json");
  await Bun.write(path, JSON.stringify({}));
  expect((await loadConfig(path, "/home/ana")).leadCwd).toBe("/home/ana/.dori/lead");
  await Bun.write(path, JSON.stringify({ defaultCwd: "~/old" }));
  expect((await loadConfig(path, "/home/ana")).leadCwd).toBe("/home/ana/old");
  await Bun.write(path, JSON.stringify({ defaultCwd: "~/old", leadCwd: "/srv/lead" }));
  expect((await loadConfig(path, "/home/ana")).leadCwd).toBe("/srv/lead");
});

test("leadDiet is built in: a leadDiet key in the file is ignored", async () => {
  const path = join(state.dir, "diet.json");
  await Bun.write(path, JSON.stringify({ leadDiet: false }));
  expect("leadDiet" in await loadConfig(path, "/home/ana")).toBe(false);
  expect(BUILT_IN.leadDiet).toBe(true);
});

test("laneRules defaults to none, collapses whitespace, drops blanks, and refuses anything but an array of strings", async () => {
  const path = join(state.dir, "rules.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 7 }));
  expect((await loadConfig(path, "/home/ana")).laneRules).toEqual([]);
  await Bun.write(path, JSON.stringify({ laneRules: null }));
  expect((await loadConfig(path, "/home/ana")).laneRules).toEqual([]);
  await Bun.write(path, JSON.stringify({ laneRules: [" Do not\n merge. ", "  ", "CI runs the typecheck only."] }));
  expect((await loadConfig(path, "/home/ana")).laneRules).toEqual(["Do not merge.", "CI runs the typecheck only."]);
  await Bun.write(path, JSON.stringify({ laneRules: "Do not merge." }));
  await expect(loadConfig(path, "/home/ana")).rejects.toThrow("laneRules must be an array of strings");
});

test("laneSandbox is lane-sandbox when absent, ignores a leftover default key, and refuses a bad shape", async () => {
  const path = join(state.dir, "sandbox.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 7 }));
  expect((await loadConfig(path, "/home/ana")).laneSandbox).toEqual({ command: ["lane-sandbox"] });
  await Bun.write(path, JSON.stringify({ laneSandbox: { command: ["lane-sandbox", "--strict"] } }));
  expect((await loadConfig(path, "/home/ana")).laneSandbox).toEqual({ command: ["lane-sandbox", "--strict"] });
  for (const leftover of [false, true, "yes"]) {
    await Bun.write(path, JSON.stringify({ laneSandbox: { command: ["lane-sandbox"], default: leftover } }));
    expect((await loadConfig(path, "/home/ana")).laneSandbox).toEqual({ command: ["lane-sandbox"] });
  }
  for (const bad of [["lane-sandbox"], "lane-sandbox", { command: [] }, { command: "lane-sandbox" }, { command: ["lane-sandbox", " "] }, { command: [1] }, { default: false }]) {
    await Bun.write(path, JSON.stringify({ laneSandbox: bad }));
    await expect(loadConfig(path, "/home/ana")).rejects.toThrow(TypeError);
  }
});

test("laneSandbox never touches the lead's command", () => {
  const config = { ...defaultConfig("/home/test"), defaultModel: "m/lane" };
  expect(leadCommand({ ...config, laneSandbox: { command: ["lane-sandbox"] } }, "@p")).toEqual(leadCommand(config, "@p"));
  expect(leadCommand({ ...config, laneSandbox: { command: ["lane-sandbox"] } }, "@p")).not.toContain("lane-sandbox");
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

});

test("only user and environment keys are read: unknown, removed and malformed tunable keys load as defaults, named in one CONFIG_KEYS_IGNORED line per process", async () => {
  const path = join(state.dir, "mixed.json");
  await Bun.write(path, JSON.stringify({
    schemaVersion: 1, defaultModel: "m/lane", store: "sqlite", ciMergeBase: "release",
    futureKey: { a: 1 }, operations: false, quotaGate: { pollMin: 5 }, toodo: { url: "x" }, laneFinishNotice: true,
    drift: "x", runners: { listen: "8.8.8.8:1", mode: { mini: "shadow" } }, eventPolicy: 7, resolveKinds: "x",
    delivery: { mode: "push", push: { ackSec: 1 } }, guard: { memFreeCritPct: 3 }, heavyKill: "qemu-system", closeAfterMin: 7,
    memoryCheck: { repo: "~/memory", maxKb: 9 }, hooks: { threadDone: ["x"], threadReply: ["reply", "{text}"] },
    laneSandbox: { command: ["lane-sandbox"], default: false }, placement: { defaultMachine: "big", workspaces: { "*": "mini" } },
    sessionsDir: "~/sessions", diskGuardPath: "/mnt", laneThinking: "high", toodoEvents: { enabled: false },
  }));
  // A fresh process, so the once-per-process warning is not already spent by another test file.
  const script = `const { defaultConfig, loadConfig } = await import(${JSON.stringify(join(import.meta.dir, "../src/config.ts"))});
    const a = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    const b = await loadConfig(${JSON.stringify(path)}, "/home/ana");
    const d = defaultConfig("/home/ana");
    const same = ["drift", "guard", "heavyKill"].filter((k) => JSON.stringify(a[k]) === JSON.stringify(d[k]));
    const tunables = ["closeAfterMin", "eventPolicy", "resolveKinds", "delivery", "sessionsDir", "laneThinking", "toodoEvents"].filter((k) => k in a);
    console.log(JSON.stringify({ same, model: b.defaultModel, base: a.ciMergeBase, memoryCheck: a.memoryCheck, hooks: a.hooks, sandbox: a.laneSandbox, runners: "runners" in a, future: "futureKey" in a, store: a.store, tunables, diskGuard: "diskGuardPath" in a }));`;
  const p = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DORI_STATE_DIR: state.dir } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({
    same: ["drift", "guard", "heavyKill"],
    model: "m/lane", base: "release", memoryCheck: { repo: "", maxKb: 15 }, hooks: { threadReply: ["reply", "{text}"] },
    sandbox: { command: ["lane-sandbox"] }, runners: false, future: false,
    store: "json", tunables: [], diskGuard: false,
  });
  const ignored = "store, futureKey, operations, quotaGate, toodo, laneFinishNotice, drift, eventPolicy, resolveKinds, delivery, guard, heavyKill, closeAfterMin, memoryCheck, sessionsDir, diskGuardPath, laneThinking, toodoEvents, hooks.threadDone, laneSandbox.default, placement.workspaces, runners.listen, runners.mode";
  expect(err.split("\n").filter((line) => line.startsWith("CONFIG_"))).toEqual([`CONFIG_KEYS_IGNORED ${ignored} in ${path}: these keys are no longer read from config.json; they can be deleted`]);
});

test("an old config's task-tracker keys (memoryCheck.toodoMcp/toodoTokenFile, ciToodoWorkspaces) load without error", async () => {
  const path = join(state.dir, "old-tracker.json");
  await Bun.write(path, JSON.stringify({
    memoryCheck: { repo: "~/memory", maxKb: 9, toodoMcp: "http://127.0.0.1:1/mcp", toodoTokenFile: "~/token" },
    ciToodoWorkspaces: { "acme/app": 3 },
  }));
  const c = await loadConfig(path, "/home/ana");
  expect(c.memoryCheck.repo).toBe("");
  expect(c.memoryCheck.maxKb).toBe(15);
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

test("a lead context cap in the file is ignored: the built-in default holds", async () => {
  const local = withState();
  try {
    const path = join(local.dir, "cap.json");
    await Bun.write(path, JSON.stringify({ leadContextCapTokens: 42_000 }));
    expect("leadContextCapTokens" in await loadConfig(path, "/home/ana")).toBe(false);
    expect(BUILT_IN.leadContextCapTokens).toBe(250_000);
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
  expect(err.split("\n").filter((line) => line.startsWith("CONFIG_KEYS_IGNORED "))).toHaveLength(1);
  expect(err.split("\n").filter((line) => line.startsWith("CONFIG_LEAD_CHAIN_REMOVED "))).toHaveLength(1);
});

test("legacy arrays with no usable entry fall back to the lane model", async () => {
  const path = join(state.dir, "empty-lead.json");
  await Bun.write(path, JSON.stringify({ leadModel: [null, " ", {}], defaultModel: "m/default", leadThinking: "low" }));
  expect(leadModels(await loadConfig(path))).toEqual([{ model: "m/default", thinking: "low" }]);
});

test("placement defaults to local with no fallback", async () => {
  expect(defaultConfig("/home/ana").placement).toEqual({ defaultMachine: "local", fallback: [] });
  const path = join(state.dir, "placement-none.json");
  await Bun.write(path, JSON.stringify({ closeAfterMin: 7 }));
  expect((await loadConfig(path, "/home/ana")).placement).toEqual({ defaultMachine: "local", fallback: [] });
});

test("placement parses trimmed machines, does not read a workspaces table, and blank defaultMachine means local", async () => {
  const path = join(state.dir, "placement.json");
  await Bun.write(path, JSON.stringify({ placement: { defaultMachine: " big ", workspaces: { "/data/repos": " mini ", "acme/app": "", "*": 3 }, fallback: [" mini ", "big"] } }));
  expect((await loadConfig(path, "/home/ana")).placement).toEqual({ defaultMachine: "big", fallback: ["mini", "big"] });
  await Bun.write(path, JSON.stringify({ placement: { defaultMachine: "  " } }));
  expect((await loadConfig(path, "/home/ana")).placement).toEqual({ defaultMachine: "local", fallback: [] });
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

test("alertsChannel routes system notices when set; unset or blank falls back to the first discordChannels entry", async () => {
  const path = join(state.dir, "alerts.json");
  const load = async (raw: Record<string, unknown>) => { await Bun.write(path, JSON.stringify(raw)); return loadConfig(path, "/home/ana"); };
  expect(alertsChannelOf(await load({ discordChannels: ["111", "222"], alertsChannel: " 222 " }))).toBe("222");
  expect(alertsChannelOf(await load({ discordChannels: ["111", "222"] }))).toBe("111");
  expect(alertsChannelOf(await load({ discordChannels: ["111"], alertsChannel: " " }))).toBe("111");
  expect(alertsChannelOf(await load({}))).toBeUndefined();
  await expect(load({ alertsChannel: 222 })).rejects.toThrow("alertsChannel must be a Discord channel id string");
});

test("guard thresholds and heavyKill are built in: file values, even malformed ones, are ignored", async () => {
  const path = join(state.dir, "crit.json");
  await Bun.write(path, JSON.stringify({ guard: { memFreeCritPct: 3 }, heavyKill: "qemu-system" }));
  const c = await loadConfig(path, "/home/ana");
  expect(c.guard).toEqual(defaultConfig("/home/ana").guard);
  expect(c.heavyKill).toEqual(["qemu-system", "emulator", "expo export"]);
});

test("runners.<label>.allowUnsandboxed loads per machine, legacy runner keys are dropped, and a bad shape is refused", async () => {
  const path = join(state.dir, "runners.json");
  await Bun.write(path, JSON.stringify({ runners: { listen: "0.0.0.0:7411", mini: { allowUnsandboxed: true }, box: {} } }));
  expect((await loadConfig(path, "/home/ana")).runners).toEqual({ mini: { allowUnsandboxed: true }, box: {} });
  for (const runners of [{ mini: { allowUnsandboxed: "yes" } }, { mini: true }, "mini"]) {
    await Bun.write(path, JSON.stringify({ runners }));
    await expect(loadConfig(path, "/home/ana")).rejects.toBeInstanceOf(TypeError);
  }
});
