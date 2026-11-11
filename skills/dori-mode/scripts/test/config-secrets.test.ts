import { expect, test } from "bun:test";
import { join } from "node:path";

import { CONFIG_FILE_KEYS, defaultConfig, loadConfig } from "../src/config.ts";
import { CONFIG_SCHEMA_VERSION, migrateConfigSchema } from "../src/config-schema.ts";
import { pruneObsolete } from "../src/setup.ts";
import { withState } from "./fakes.ts";

const state = withState();

const load = async (name: string, body: unknown) => {
  const path = join(state.dir, `${name}.json`);
  await Bun.write(path, JSON.stringify(body));
  return loadConfig(path, "/home/ana");
};

test("secrets is a config file key and defaults to no grants", async () => {
  expect(CONFIG_FILE_KEYS).toContain("secrets");
  expect(defaultConfig("/home/ana").secrets).toEqual({});
  expect((await load("none", {})).secrets).toEqual({});
});

test("a valid rule loads, with a missing list becoming empty", async () => {
  const c = await load("valid", { secrets: { NPM_TOKEN: { lanes: ["a-lane", "prefix-*"], repos: ["Dubusoft/dori-mode"] }, API_KEY: { lanes: ["x"] }, EMPTY_ONE: {} } });
  expect(c.secrets).toEqual({
    NPM_TOKEN: { lanes: ["a-lane", "prefix-*"], repos: ["Dubusoft/dori-mode"] },
    API_KEY: { lanes: ["x"], repos: [] },
    EMPTY_ONE: { lanes: [], repos: [] },
  });
});

test("a bad shape or a lower-case name throws TypeError", async () => {
  const bad: unknown[] = [
    "NPM_TOKEN",
    ["NPM_TOKEN"],
    { npm_token: { lanes: [] } },
    { NPM_TOKEN: [] },
    { NPM_TOKEN: { lanes: "a" } },
    { NPM_TOKEN: { repos: [1] } },
    { NPM_TOKEN: { lanes: [], other: [] } },
  ];
  for (const [i, secrets] of bad.entries()) {
    await expect(load(`bad-${i}`, { secrets })).rejects.toBeInstanceOf(TypeError);
  }
});

const MINT = { kind: "github-app", appId: "123", installationId: "456", keySecret: "GH_APP_KEY", permissions: { contents: "write", pull_requests: "read" } } as const;

test("as and mint load on a rule", async () => {
  const c = await load("as-mint", { secrets: { DEPLOY_KEY: { lanes: ["a"], as: "ssh-key" }, PLAIN: { as: "env" }, GH_TOKEN: { repos: ["o/r"], mint: MINT } } });
  expect(c.secrets.DEPLOY_KEY).toEqual({ lanes: ["a"], repos: [], as: "ssh-key" });
  expect(c.secrets.PLAIN).toEqual({ lanes: [], repos: [], as: "env" });
  expect(c.secrets.GH_TOKEN).toEqual({ lanes: [], repos: ["o/r"], mint: MINT });
});

test("a bad as or mint throws TypeError", async () => {
  const { kind: _k, ...noKind } = MINT;
  const bad: unknown[] = [
    { A: { as: "file" } },
    { A: { as: 1 } },
    { A: { as: "ssh-key", mint: MINT } },
    { A: { mint: "x" } },
    { A: { mint: { ...MINT, kind: "gitlab" } } },
    { A: { mint: noKind } },
    { A: { mint: { ...MINT, appId: "" } } },
    { A: { mint: { ...MINT, installationId: 456 } } },
    { A: { mint: { ...MINT, keySecret: "lower" } } },
    { A: { mint: { ...MINT, permissions: {} } } },
    { A: { mint: { ...MINT, permissions: { Contents: "write" } } } },
    { A: { mint: { ...MINT, permissions: { contents: "admin" } } } },
    { A: { mint: { ...MINT, extra: 1 } } },
  ];
  for (const [i, secrets] of bad.entries()) {
    await expect(load(`bad-mint-${i}`, { secrets })).rejects.toBeInstanceOf(TypeError);
  }
});

test("schema 6 fills secrets into a version-5 file and setup stamps the new version", () => {
  const migrated = migrateConfigSchema({ schemaVersion: 5, defaultModel: "a/b" });
  expect(migrated.next.secrets).toEqual({});
  expect(migrated.filled).toEqual(["secrets"]);
  const pruned = pruneObsolete({ log: () => {} }, state.dir, { schemaVersion: 5, defaultModel: "a/b" });
  expect(pruned).toMatchObject({ schemaVersion: CONFIG_SCHEMA_VERSION, secrets: {} });
});
