import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { grantSecretRule, loadConfig, type SecretCommand } from "../src/config.ts";
import {
  closeOwnerDecision, type DecisionContext, type DecisionTransport, ownerDecisionTick, readDecisions, SECRET_REQUESTS_PER_LANE, secretRequester,
} from "../src/owner-decisions.ts";
import { secretGranter } from "../src/runner/secret-grant.ts";

const VALUE = "dori-test-throwaway-123";
const NOW = 1_800_000_000_000;
const REPO = "Dubusoft/dori-mode";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A fake Discord that counts started threads; every thread gets a new numeric id. */
const fakeTransport = () => {
  let seq = 1000;
  const threads: string[] = [];
  const transport: DecisionTransport = {
    send: async () => `${++seq}`,
    edit: async () => {},
    content: async () => "",
    deleteMessage: async () => {},
    messagesAfter: async () => [],
    startThread: async () => { const id = `${++seq}`; threads.push(id); return { id }; },
    setThread: async () => {},
    threadState: async () => ({ archived: false, parent: "555" }),
    threadArchived: async () => true,
  };
  return { transport, threads };
};

/** One supervisor host: state dir, config file read per request by the granter, decision tick, and the CLI's config writer. */
const host = (config: Record<string, unknown> = {}, commands: Record<string, SecretCommand> = {}, repoOf: (key: string) => string | undefined = () => REPO) => {
  const dir = mkdtempSync(join(tmpdir(), "secret-request-"));
  dirs.push(dir);
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const fake = fakeTransport();
  const events: string[] = [];
  const ctx: DecisionContext = {
    config: { stateDir: dir, discordChannels: ["999"], decisionsChannel: "555", alertsChannel: undefined, displayTimeZone: "UTC" },
    transport: fake.transport, now: () => NOW, home: "/home/test",
    secretGrant: (names, to) => grantSecretRule(configPath, names, to),
  };
  const grant = secretGranter({
    store: { read: async () => VALUE },
    rules: async () => (await loadConfig(configPath, "/home/test")).secrets,
    laneRepo: async (key) => repoOf(key),
    audit: () => {},
    runner: "r1",
    now: () => NOW,
    request: secretRequester(dir, async () => commands, () => NOW),
  });
  const tick = () => ownerDecisionTick({ ...ctx, enqueue: (_id, line) => { events.push(line); }, log: () => {} });
  const decisions = () => readDecisions(dir).decisions;
  const rules = () => (JSON.parse(readFileSync(configPath, "utf8")) as { secrets?: unknown }).secrets;
  return { dir, ctx, grant, tick, decisions, rules, threads: fake.threads, events };
};

test("a name outside the allowlist opens one owner decision; allowing this lane makes the next exec succeed", async () => {
  const h = host({ defaultModel: "a/b" });
  const denied = await h.grant("ap-1-1", ["NPM_TOKEN"]);
  expect(denied).toMatchObject({ ok: false, code: "RUNNER_SECRET_DENIED" });
  expect(denied.ok ? "" : denied.detail).toContain("the owner is asked in an owner decision");
  await h.tick();
  expect(h.threads).toHaveLength(1);
  const [d] = h.decisions();
  expect(d).toMatchObject({ state: "open", lane: "ap-1-1", task: 1, secretRequest: { names: ["NPM_TOKEN"], repo: REPO, grants: ["lane", "repo", "deny"] } });
  expect(d?.options).toHaveLength(3);
  expect(readDecisions(h.dir).secretRequests).toEqual([]);

  const closed = await closeOwnerDecision(h.ctx, d?.id ?? "", { text: "allowed for this lane", choice: 1 });
  expect(closed.granted).toEqual({ names: ["NPM_TOKEN"], to: { lane: "ap-1-1" }, changed: ["NPM_TOKEN"] });
  expect(h.rules()).toEqual({ NPM_TOKEN: { lanes: ["ap-1-1"] } });
  expect((JSON.parse(readFileSync(join(h.dir, "config.json"), "utf8")) as { defaultModel: string }).defaultModel).toBe("a/b");
  expect(await h.grant("ap-1-1", ["NPM_TOKEN"])).toEqual({ ok: true, values: { NPM_TOKEN: VALUE } });
  expect((await h.grant("ap-2-1", ["NPM_TOKEN"])).ok).toBe(false);
});

test("allowing the repo grants every lane of that repo and no other", async () => {
  const h = host({}, {}, (key) => (key.startsWith("other") ? "Dubusoft/other" : REPO));
  await h.grant("ap-1-1", ["NPM_TOKEN"]);
  await h.tick();
  const closed = await closeOwnerDecision(h.ctx, h.decisions()[0]?.id ?? "", { text: "repo", choice: 2 });
  expect(closed.granted?.to).toEqual({ repo: REPO });
  expect(h.rules()).toEqual({ NPM_TOKEN: { repos: [REPO] } });
  expect((await h.grant("ap-9-1", ["NPM_TOKEN"])).ok).toBe(true);
  expect((await h.grant("other-1", ["NPM_TOKEN"])).ok).toBe(false);
});

test("a deny leaves config alone and the lane stays denied without a new decision", async () => {
  const h = host();
  await h.grant("ap-1-1", ["NPM_TOKEN"]);
  await h.tick();
  const closed = await closeOwnerDecision(h.ctx, h.decisions()[0]?.id ?? "", { text: "no", choice: 3 });
  expect(closed.granted).toBeUndefined();
  expect(h.rules()).toBeUndefined();
  const again = await h.grant("ap-1-1", ["NPM_TOKEN"]);
  expect(again.ok ? "" : again.detail).toContain("the owner was already asked (decision d1)");
  await h.tick();
  expect(h.decisions()).toHaveLength(1);
  expect(h.threads).toHaveLength(1);
});

test("repeated requests of one lane open no new decision, before or after the tick, and a lane is capped", async () => {
  const h = host();
  await h.grant("ap-1-1", ["NPM_TOKEN"]);
  const queuedTwice = await h.grant("ap-1-1", ["NPM_TOKEN"]);
  expect(queuedTwice.ok ? "" : queuedTwice.detail).toContain("the owner was already asked; no new decision");
  await h.tick();
  await h.grant("ap-1-1", ["NPM_TOKEN"]);
  await h.tick();
  expect(h.decisions()).toHaveLength(1);

  for (const name of ["TOKEN_B", "TOKEN_C"]) await h.grant("ap-1-1", [name]);
  const capped = await h.grant("ap-1-1", ["TOKEN_D"]);
  expect(capped.ok ? "" : capped.detail).toContain(`already asked for ${SECRET_REQUESTS_PER_LANE} secrets`);
  await h.tick();
  expect(h.decisions().map((d) => d.secretRequest?.names)).toEqual([["NPM_TOKEN"], ["TOKEN_B"], ["TOKEN_C"]]);
  await h.grant("ap-2-1", ["NPM_TOKEN"]);
  await h.tick();
  expect(h.decisions()).toHaveLength(4);
});

test("a secretCommands secret is never offered: it goes through secret run only", async () => {
  const h = host({}, { deploy: { argv: ["deploy"], secrets: ["CF_TOKEN"], lanes: [], repos: [], timeoutSec: 60 } });
  const denied = await h.grant("ap-1-1", ["CF_TOKEN"]);
  expect(denied.ok ? "" : denied.detail).toContain("CF_TOKEN go only through dori secret run <op>");
  await h.tick();
  expect(h.decisions()).toEqual([]);
});

test("a close that cannot write config fails and leaves the decision open", async () => {
  const h = host();
  await h.grant("ap-1-1", ["NPM_TOKEN"]);
  await h.tick();
  const { secretGrant: _, ...noWriter } = h.ctx;
  await expect(closeOwnerDecision(noWriter, "d1", { text: "yes", choice: 1 })).rejects.toMatchObject({ code: "DECISION_GRANT_FAILED" });
  expect(h.decisions()[0]?.state).toBe("open");
});
