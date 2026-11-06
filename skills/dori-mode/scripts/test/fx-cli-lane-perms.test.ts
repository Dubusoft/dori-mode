import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { Registry } from "../src/registry.ts";

// Each test spawns several `bun src/cli.ts` processes; under a loaded full run on a small host that outgrows bun's
// default 5 s per test, so the limit here allows for process startup instead of failing on load.
setDefaultTimeout(30_000);

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fx-cli-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cli = async (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: process.env.TMPDIR ?? dir, DORI_CONFIG: join(dir, "no-config.json"), DORI_STATE_DIR: dir, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

const lead = (key: string) => ({
  key, title: "t", brief: "b", done: "d", thread: "discord:1/2", pane: undefined, status: "working",
}) as never;

test("lead-only commands refuse under DORI_LANE_KEY with a clear message and nonzero exit", async () => {
  const inLane = { DORI_LANE_KEY: "demo-lane" };
  const cmds = [
    ["ack", "11", "22"], ["handled", "11", "22"], ["launch", "k", "--title", "t", "--brief", "b", "--done", "d"],
    ["adopt", "k", "--title", "t", "--brief", "b", "--done", "d", "--pane", "p"],
    ["hold", "list"], ["hold", "drop", "k"], ["lead-restart"], ["inbox", "take"], ["update"],
    ["send", "discord", "--to", "discord:1/2", "--text", "hi"],
  ];
  for (const args of cmds) {
    const r = await cli(args, inLane);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`LANE_PERMISSION_DENIED lane demo-lane may not run ${args[0]}; it is lead-only`);
  }
});

test("the lead (no DORI_LANE_KEY) is not refused on the same commands", async () => {
  const hold = await cli(["hold", "list"]);
  expect(hold.code).toBe(0);
  expect(hold.out.trim()).toBe("[]");
  for (const args of [["ack"], ["handled"], ["lead-restart", "extra"]]) {
    const r = await cli(args);
    expect(r.err).not.toContain("LANE_PERMISSION_DENIED");
    expect(r.err).toContain("usage:");
  }
});

test("object-done is limited to the lane's own key; the lead may object on any lane", async () => {
  await new Registry(dir).write(lead("other-lane"));
  const denied = await cli(["object-done", "other-lane", "--reason", "x"], { DORI_LANE_KEY: "demo-lane" });
  expect(denied.code).toBe(1);
  expect(denied.err).toContain("LANE_PERMISSION_DENIED lane demo-lane may not object-done lane other-lane");
  const own = await cli(["object-done", "demo-lane"], { DORI_LANE_KEY: "demo-lane" });
  expect(own.err).not.toContain("LANE_PERMISSION_DENIED");
  expect(own.err).toContain("--reason is required");
  const asLead = await cli(["object-done", "other-lane"]);
  expect(asLead.err).toContain("--reason is required");
  expect(asLead.err).not.toContain("LANE_PERMISSION_DENIED");
});

test("typing discord refuses --off with the usage text before any token lookup", async () => {
  const r = await cli(["typing", "discord", "123", "--off"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("usage: dori typing [discord] <channel>");
  expect(r.err).not.toContain("DORI_DISCORD_TOKEN");
});

test("read-only commands stay allowed under DORI_LANE_KEY", async () => {
  const r = await cli(["can-launch"], { DORI_LANE_KEY: "demo-lane" });
  expect(r.err).not.toContain("LANE_PERMISSION_DENIED");
});
