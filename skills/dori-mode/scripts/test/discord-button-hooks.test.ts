import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { buttonRow } from "../src/messenger/discord-buttons.ts";
import { DiscordCommands } from "../src/messenger/discord-commands.ts";
import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { withState } from "./fakes.ts";

const config = { applicationId: "100", guildId: "200", ownerId: "300" };
const hooks = { blog: ["/hooks/approve.sh", "--record-button", "{arg}", "--interaction", "{interaction}", "--channel", "{channel}", "--msg", "{message}", "{name}"] };
const PUBLISH = "dori:hook:blog:publish:12:abcdef012345";
const REVISE = "dori:hook:blog:revise:12:abcdef012345";
const rows = [{ type: 1, components: [
  { type: 2, style: 3, label: "게시", custom_id: PUBLISH },
  { type: 2, style: 2, label: "수정 요청", custom_id: REVISE },
] }];
const click = (customId: string, userId = "300") => ({
  type: 3, id: "400", token: "interaction-secret", application_id: "100", guild_id: "200", channel_id: "700",
  data: { component_type: 2, custom_id: customId }, member: { user: { id: userId } },
  message: { id: "800", content: "draft ready", components: rows },
});

const fixture = () => {
  const requests: HttpRequest[] = [];
  const spawned: { argv: readonly string[]; name: string }[] = [];
  const emitted: string[] = [];
  const http: Http = async (req) => { requests.push(req); return { status: 204, headers: {}, body: "" }; };
  const commands = new DiscordCommands(http, "bot", config, async () => "", undefined, [], undefined, undefined, {
    hooks,
    spawn: (argv, name) => { spawned.push({ argv, name }); },
    clicked: async (name, arg, channel, interaction) => { emitted.push(`discord:${channel}:button:${interaction} BUTTON_CLICKED_BY_OWNER ${name} ${arg}`); },
  });
  return { requests, spawned, emitted, commands };
};
const payload = (req: HttpRequest | undefined): unknown => JSON.parse(String(req?.body));

test("the owner's plain hook click disables every button, marks the clicked one, then runs the filled hook and emits", async () => {
  const { commands, requests, spawned, emitted } = fixture();
  await commands.handle(click(PUBLISH));
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://discord.com/api/v10/interactions/400/interaction-secret/callback");
  expect(payload(requests[0])).toEqual({ type: 7, data: { components: [{ type: 1, components: [
    { type: 2, style: 3, label: "게시 - 접수됨", custom_id: PUBLISH, disabled: true },
    { type: 2, style: 2, label: "수정 요청", custom_id: REVISE, disabled: true },
  ] }] } });
  expect(spawned).toEqual([{ name: "blog", argv: ["/hooks/approve.sh", "--record-button", "publish:12:abcdef012345", "--interaction", "400", "--channel", "700", "--msg", "800", "blog"] }]);
  expect(emitted).toEqual(["discord:700:button:400 BUTTON_CLICKED_BY_OWNER blog publish:12:abcdef012345"]);
});

test("a non-owner or a foreign guild gets an ephemeral refusal and no hook runs", async () => {
  const { commands, requests, spawned, emitted } = fixture();
  await commands.handle(click(PUBLISH, "999"));
  await commands.handle({ ...click(PUBLISH), guild_id: "999" });
  expect(requests.map((r) => payload(r))).toEqual([
    { type: 4, data: { flags: 64, content: expect.any(String) } },
    { type: 4, data: { flags: 64, content: expect.any(String) } },
  ]);
  expect(spawned).toEqual([]);
  expect(emitted).toEqual([]);
});

test("an unconfigured hook name gets the ephemeral unknown-button reply and no hook runs", async () => {
  const { commands, requests, spawned } = fixture();
  await commands.handle(click("dori:hook:other:x"));
  expect(payload(requests[0])).toEqual({ type: 4, data: { flags: 64, content: "알 수 없는 버튼입니다." } });
  expect(spawned).toEqual([]);
});

test("clicking the other button of the row marks that one and passes its own arg", async () => {
  const { commands, requests, spawned } = fixture();
  await commands.handle({ ...click(REVISE), id: "401" });
  expect(payload(requests[0])).toMatchObject({ type: 7, data: { components: [{ components: [
    { label: "게시", disabled: true }, { label: "수정 요청 - 접수됨", disabled: true },
  ] }] } });
  expect(spawned[0]?.argv).toEqual(["/hooks/approve.sh", "--record-button", "revise:12:abcdef012345", "--interaction", "401", "--channel", "700", "--msg", "800", "blog"]);
});

test("modal-style ids and modal submits are not hook buttons: no reply, no hook", async () => {
  const { commands, requests, spawned } = fixture();
  await commands.handle(click("dori:hookm:blog:revise:12"));
  await commands.handle({ ...click(PUBLISH), type: 5, data: { custom_id: PUBLISH, components: [] } });
  expect(requests).toEqual([]);
  expect(spawned).toEqual([]);
});

test("a failed acknowledgement runs no hook", async () => {
  const spawned: unknown[] = [];
  const http: Http = async () => ({ status: 500, headers: {}, body: "" });
  const commands = new DiscordCommands(http, "bot", config, async () => "", undefined, [], undefined, undefined, { hooks, spawn: (argv) => { spawned.push(argv); } });
  await commands.handle(click(PUBLISH));
  expect(spawned).toEqual([]);
});

test("buttonRow builds one action row and rejects bad ids, counts and styles", () => {
  expect(buttonRow(JSON.stringify([{ label: "게시", id: PUBLISH, style: "success" }, { label: "수정", id: REVISE }]))).toEqual([{ type: 1, components: [
    { type: 2, style: 3, label: "게시", custom_id: PUBLISH }, { type: 2, style: 2, label: "수정", custom_id: REVISE },
  ] }]);
  expect(() => buttonRow("[]")).toThrow("1 to 5");
  expect(() => buttonRow("nope")).toThrow("JSON array");
  expect(() => buttonRow(JSON.stringify([{ label: "x", id: "dori:hook:Blog:x" }]))).toThrow("--buttons[0].id must match");
  expect(() => buttonRow(JSON.stringify([{ label: "x", id: "dori:close-thread:1" }]))).toThrow("--buttons[0].id must match");
  expect(() => buttonRow(JSON.stringify([{ label: "x", id: "dori:hookm:blog:x" }]))).toThrow("--buttons[0].id must match ^dori:hook:");
  expect(() => buttonRow(JSON.stringify([{ label: "x", id: PUBLISH, style: "link" }]))).toThrow("style");
  expect(() => buttonRow(JSON.stringify([{ label: "a", id: PUBLISH }, { label: "b", id: PUBLISH }]))).toThrow("repeats");
});

const send = async (home: string, buttons: string) => {
  const preload = join(home, "fake-fetch.js");
  writeFileSync(preload, 'globalThis.fetch = async (_u, init) => { console.log("FAKE_BODY " + init.body); return new Response(JSON.stringify({ id: "1" }), { status: 200 }); };');
  const child = Bun.spawn(["bun", "--preload", preload, join(import.meta.dir, "../src/cli.ts"), "send", "discord", "--to", "123", "--text", "x", "--buttons", buttons], {
    env: { PATH: process.env.PATH ?? "", HOME: home, DORI_CONFIG: join(home, "missing.json"), DORI_STATE_DIR: join(home, "state"), DORI_DISCORD_TOKEN: "t" },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
};

test("dori send --buttons rejects a bad id with a clear error, exits non-zero and posts nothing", async () => {
  const state = withState();
  try {
    const r = await send(state.dir, JSON.stringify([{ label: "x", id: "dori:hook:blog:bad id" }]));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("--buttons[0].id must match");
    expect(r.out).not.toContain("FAKE_BODY");
  } finally { state.done(); }
});

test("dori send --buttons posts the action row and prints SENT", async () => {
  const state = withState();
  try {
    const r = await send(state.dir, JSON.stringify([{ label: "게시", id: PUBLISH, style: "success" }]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT 1");
    const body = JSON.parse(r.out.split("\n").find((l) => l.startsWith("FAKE_BODY "))!.slice(10));
    expect(body.components).toEqual([{ type: 1, components: [{ type: 2, style: 3, label: "게시", custom_id: PUBLISH }] }]);
  } finally { state.done(); }
});

test("config buttonHooks keeps valid entries and drops invalid ones with one warning", async () => {
  const state = withState();
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: string) => { errors.push(line); };
  try {
    const path = join(state.dir, "config.json");
    writeFileSync(path, JSON.stringify({ buttonHooks: { blog: ["/a", "{arg}"], "Bad Name": ["/b"], empty: [], mixed: ["/c", 1] } }));
    const loaded = await loadConfig(path, state.dir);
    expect(loaded.buttonHooks).toEqual({ blog: ["/a", "{arg}"] });
    expect(errors.filter((l) => l.startsWith("CONFIG_BUTTON_HOOKS_INVALID"))).toHaveLength(1);
    expect((await loadConfig(join(state.dir, "missing.json"), state.dir)).buttonHooks).toBeUndefined();
  } finally {
    console.error = original;
    state.done();
  }
});
