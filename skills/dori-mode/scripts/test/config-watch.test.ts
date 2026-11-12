import { afterEach, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type DoriConfig, loadConfig } from "../src/config.ts";
import { applyConfigPatch, type ConfigReload, configReloader, watchConfigFiles } from "../src/config-watch.ts";
import { withState } from "./fakes.ts";

const state = withState();
const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

const discord = { applicationId: "1", guildId: "2", ownerId: "300" };
const write = (path: string, value: unknown): void => { writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };

const fixture = async (file: Record<string, unknown> = {}) => {
  const path = join(state.dir, "config.json");
  write(path, { discord, discordChannels: ["100"], stateDir: state.dir, ...file });
  const config = await loadConfig(path, "/home/ana");
  const events: [string, string][] = [];
  const logs: string[] = [];
  const reload = configReloader({
    path, current: () => config, apply: (patch) => { applyConfigPatch([config], patch); },
    enqueue: (id, line) => { events.push([id, line]); }, log: (line) => { logs.push(line); },
    load: (p) => loadConfig(p, "/home/ana"),
  });
  return { path, config, events, logs, reload };
};

test("a valid edit applies live keys in place and reports restart-only keys without applying them", async () => {
  const f = await fixture();
  const held: DoriConfig = f.config;
  write(f.path, { discord: { ...discord, guildId: "9" }, discordChannels: ["100", "200"], stateDir: state.dir, githubIssueAuthors: ["ana"] });
  const result = await f.reload();
  expect(result).toEqual({ state: "applied", live: ["discordChannels", "githubIssueAuthors"], restart: ["discord"] });
  expect(held.discordChannels).toEqual(["100", "200"]);
  expect(held.githubIssueAuthors).toEqual(["ana"]);
  expect(held.discord?.guildId).toBe("2");
  expect(f.events.map(([, line]) => line.split(" ")[0])).toEqual(["CONFIG_RELOADED", "CONFIG_RELOAD_RESTART_NEEDED"]);
  expect(f.events[1]?.[1]).toContain("discord changed");
});

test("an unchanged file reports nothing, and the same content is reported under the same event id", async () => {
  const f = await fixture();
  expect(await f.reload()).toEqual({ state: "applied", live: [], restart: [] });
  expect(f.events).toEqual([]);
  write(f.path, "{ broken");
  await f.reload();
  await f.reload();
  expect(f.events).toHaveLength(2);
  expect(f.events[0]?.[0]).toBe(f.events[1]?.[0] ?? "");
});

test("an invalid edit keeps the last good config and warns: bad JSON, a wrong type, a missing file", async () => {
  const f = await fixture();
  const before = structuredClone(f.config);
  const cases: [() => void, string][] = [
    [() => { write(f.path, '{ "discordChannels": ["100", '); }, "JSON"],
    [() => { write(f.path, { discord, discordChannels: "100", stateDir: state.dir }); }, "discordChannels must be an array of strings"],
    [() => { write(f.path, { discord, discordChannels: ["100"], stateDir: state.dir, laneRules: "x" }); }, "laneRules must be an array of strings"],
    [() => { rmSync(f.path); }, "missing or empty"],
  ];
  for (const [edit, why] of cases) {
    edit();
    const result: ConfigReload = await f.reload();
    expect(result.state).toBe("invalid");
    expect(result.state === "invalid" ? result.detail : "").toContain(why);
  }
  expect(f.config).toEqual(before);
  expect(f.events.every(([id, line]) => id.startsWith("config-reload-invalid:") && line.startsWith("CONFIG_RELOAD_INVALID ") && line.endsWith("keeps the last good config"))).toBe(true);
  expect(f.logs).toHaveLength(4);
});

test("the watcher reloads after an in-place write and after an atomic rename", async () => {
  const f = await fixture();
  let next = Promise.withResolvers<ConfigReload>();
  stops.push(watchConfigFiles([f.path], async () => { const r = await f.reload(); next.resolve(r); }, { debounceMs: 20, pollMs: 60_000 }));
  write(f.path, { discord, discordChannels: ["100", "200"], stateDir: state.dir });
  expect(await next.promise).toEqual({ state: "applied", live: ["discordChannels"], restart: [] });
  next = Promise.withResolvers<ConfigReload>();
  write(`${f.path}.tmp`, { discord, discordChannels: ["300"], stateDir: state.dir });
  renameSync(`${f.path}.tmp`, f.path);
  expect((await next.promise).state).toBe("applied");
  expect(f.config.discordChannels).toEqual(["300"]);
});

test("a file whose directory cannot be watched is still picked up by the periodic check", async () => {
  const dir = join(state.dir, "later");
  const path = join(dir, "config.json");
  const logs: string[] = [];
  const seen = Promise.withResolvers<void>();
  stops.push(watchConfigFiles([path], async () => { seen.resolve(); }, { debounceMs: 1, pollMs: 25, log: (line) => { logs.push(line); } }));
  expect(logs[0]).toStartWith(`CONFIG_WATCH_FALLBACK ${dir}`);
  mkdirSync(dir);
  write(path, {});
  await seen.promise;
});
