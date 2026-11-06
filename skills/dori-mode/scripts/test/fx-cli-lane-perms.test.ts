import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { Registry, statusOf } from "../src/registry.ts";
import { fakeLaneSocket } from "./fake-lane-socket.ts";

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

test("inside a lane every command but report, claim-done, report ack, lane status and heavy exits 2 DORI_CLI_LANE_ONLY", async () => {
  const inLane = { DORI_LANE_KEY: "demo-lane" };
  const cmds = [
    ["ack", "11", "22"], ["handled", "11", "22"], ["launch", "k", "--title", "t", "--brief", "b", "--done", "d"],
    ["adopt", "k", "--title", "t", "--brief", "b", "--done", "d", "--pane", "p"],
    ["hold", "list"], ["lead-restart"], ["inbox", "take"], ["update"], ["send", "discord", "--to", "discord:1/2", "--text", "hi"],
    ["wait", "k", "--until", "x", "--note", "n"], ["emit", "KIND", "--text", "t"], ["repos", "list"], ["recover"], ["sync"], ["watch"],
    ["close", "demo-lane"], ["pause", "demo-lane"], ["object-done", "demo-lane", "--reason", "x"], ["can-launch"], ["status"], ["doctor"],
    ["runner", "probe"], ["runner", "evacuate", "worker-a"], ["setup", "--help"], ["guard", "install"],
  ];
  for (const args of cmds) {
    const r = await cli(args, inLane);
    expect(r.code).toBe(2);
    expect(r.err).toStartWith(`DORI_CLI_LANE_ONLY ${args[0]}: inside a lane dori takes only report, claim-done, report ack, lane status and heavy`);
  }
});

test("the lead (no DORI_LANE_KEY) is not refused on the same commands", async () => {
  const hold = await cli(["hold", "list"]);
  expect(hold.code).toBe(0);
  expect(hold.out.trim()).toBe("[]");
  for (const args of [["ack"], ["handled"], ["lead-restart", "extra"]]) {
    const r = await cli(args);
    expect(r.err).not.toContain("DORI_CLI_LANE_ONLY");
    expect(r.err).toContain("usage:");
  }
});

test("a pane its runner knows (whoami) is lane mode without DORI_LANE_KEY; an unknown pane or no socket is the lead", async () => {
  const sock = fakeLaneSocket(dir, (req) => (req.kind === "whoami" ? (req.pane === "w:p7" ? { ok: true, key: "demo-lane" } : { ok: true }) : { ok: true }));
  try {
    const known = await cli(["hold", "list"], { HERDR_PANE_ID: "w:p7" });
    expect(known.code).toBe(2);
    expect(known.err).toStartWith("DORI_CLI_LANE_ONLY hold:");
    expect(sock.requests).toEqual([{ kind: "whoami", pane: "w:p7" }]);
    const unknown = await cli(["hold", "list"], { HERDR_PANE_ID: "lead:p1" });
    expect(unknown.code).toBe(0);
    expect(unknown.out.trim()).toBe("[]");
  } finally { sock.close(); }
  const noSocket = await cli(["hold", "list"], { HERDR_PANE_ID: "w:p7" });
  expect(noSocket.code).toBe(0);
});

test("the lead objects on any lane; the reason is still required", async () => {
  await new Registry(dir).write(lead("other-lane"));
  const asLead = await cli(["object-done", "other-lane"]);
  expect(asLead.code).toBe(1);
  expect(asLead.err).toContain("--reason is required");
});

test("dori close with the supervisor down exits 2 RUNNER_UNAVAILABLE and leaves the lane open", async () => {
  await new Registry(dir).write(lead("demo-lane"));
  const r = await cli(["close", "demo-lane"]);
  expect(r.code).toBe(2);
  expect(r.err).toStartWith("RUNNER_UNAVAILABLE runner=local disconnected: the supervisor is not running");
  expect(statusOf((await new Registry(dir).read("demo-lane")) as never)).toBe("working");
  for (const args of [["pause", "demo-lane"], ["resume", "demo-lane"], ["object-done", "demo-lane", "--reason", "x"], ["recover"], ["sync"], ["dead-panes"], ["guard"]]) {
    const other = await cli(args);
    expect(other.code).toBe(2);
    expect(other.err).toStartWith("RUNNER_UNAVAILABLE runner=local");
  }
});

test("dori report from the lead is refused: a report is a lane's own, sent through its runner", async () => {
  const r = await cli(["report", "demo-lane", "progress", "--text", "x"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("DORI_CLI_LANE_COMMAND dori report runs only inside a lane");
});

test("typing discord refuses --off with the usage text before any token lookup", async () => {
  const r = await cli(["typing", "discord", "123", "--off"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("usage: dori typing [discord] <channel>");
  expect(r.err).not.toContain("DORI_DISCORD_TOKEN");
});
