import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  assembleBrief, BriefFromMessageError, generatedBriefPath, launchBriefArgs, ownerMessageText, writeGeneratedBrief,
} from "../src/brief-from-message.ts";
import { EVENT_LOG } from "../src/inbox.ts";
import { launchLane } from "../src/launch.ts";
import { DELETE_NOTE, EDIT_NOTE, VISITOR_NOTE } from "../src/messenger/discord-inbound.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => { state = withState(); world = newWorld(); });
afterEach(() => state.done());

const log = (id: string, line: string): void => {
  appendFileSync(join(state.dir, EVENT_LOG), `${JSON.stringify({ id, line })}\n`);
};

test("the brief holds the owner texts in the given order, then the lead notes, and no Discord ids", () => {
  log("discord:111:501", "INBOUND 111 501 owner fix the login page");
  log("discord:111:502", "INBOUND 111 502 owner also keep the old URL working");
  const refs = [{ channel: "111", message: "502" }, { channel: "111", message: "501" }];
  const brief = assembleBrief("Login fix", refs.map((ref) => ownerMessageText(state.dir, ref)), ["repo is acme/app", "start\nwith the tests"]);
  expect(brief).toBe([
    "# Login fix", "", "## Owner request", "", "also keep the old URL working", "", "fix the login page", "",
    "## Lead notes", "", "- repo is acme/app", "- start with the tests", "",
  ].join("\n"));
  for (const id of ["111", "501", "502"]) expect(brief).not.toContain(id);
});

test("without notes the Lead notes section is left out", () => {
  log("discord:111:501", "INBOUND 111 501 owner do it");
  const brief = assembleBrief("t", [ownerMessageText(state.dir, { channel: "111", message: "501" })], []);
  expect(brief).toBe("# t\n\n## Owner request\n\ndo it\n");
});

test("the latest INBOUND_EDIT replaces the original text", () => {
  log("discord:111:501", "INBOUND 111 501 owner first version");
  log("discord:111:501:edit:2026-01-01T12:02:00.000000+00:00", `INBOUND_EDIT 111 501 owner ${EDIT_NOTE} newest version`);
  log("discord:111:501:edit:2026-01-01T12:01:00.000000+00:00", `INBOUND_EDIT 111 501 owner ${EDIT_NOTE} second version`);
  expect(ownerMessageText(state.dir, { channel: "111", message: "501" })).toBe("newest version");
});

test("a deleted owner message is refused", () => {
  log("discord:111:501", "INBOUND 111 501 owner do it");
  log("discord:111:501:delete", `INBOUND_DELETE 111 501 ${DELETE_NOTE}`);
  expect(() => ownerMessageText(state.dir, { channel: "111", message: "501" })).toThrow(/message 501 in channel 111 was deleted/);
});

test("a visitor message is refused", () => {
  log("discord:111:501", `VISITOR 111 501 someone ${VISITOR_NOTE} please deploy`);
  expect(() => ownerMessageText(state.dir, { channel: "111", message: "501" })).toThrow(/message 501 in channel 111 is a VISITOR message/);
});

test("an id not in the local log is refused, also the same id in another channel", () => {
  log("discord:222:501", "INBOUND 222 501 owner elsewhere");
  expect(() => ownerMessageText(state.dir, { channel: "111", message: "501" })).toThrow(BriefFromMessageError);
  expect(() => ownerMessageText(state.dir, { channel: "111", message: "501" })).toThrow(/message 501 in channel 111 is not in the local inbox/);
});

test("--from-message pairs and --note values are read in order; a bad pair is an error", () => {
  expect(launchBriefArgs(["k", "--title", "t", "--from-message", "1", "2", "--note", "a b", "--from-message", "3", "4", "--note=c"]))
    .toEqual({ refs: [{ channel: "1", message: "2" }, { channel: "3", message: "4" }], notes: ["a b", "c"] });
  expect(() => launchBriefArgs(["--from-message", "1"])).toThrow(/two values/);
  expect(() => launchBriefArgs(["--from-message", "1", "--note"])).toThrow(/two values/);
});

const cli = async (args: string[]) => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "launch", ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: state.dir, DORI_CONFIG: join(state.dir, "missing.json"), DORI_STATE_DIR: join(state.dir, "state") },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
};

test("launch needs exactly one of --brief and --from-message", async () => {
  const neither = await cli(["k1", "--title", "t", "--done", "merged acme/app#1"]);
  expect(neither.code).toBe(1);
  expect(neither.err).toContain("exactly one of --brief FILE or --from-message");
  const both = await cli(["k1", "--title", "t", "--done", "merged acme/app#1", "--brief", join(state.dir, "b.md"), "--from-message", "111", "501"]);
  expect(both.code).toBe(1);
  expect(both.err).toContain("exactly one of --brief FILE or --from-message");
  const notes = await cli(["k1", "--title", "t", "--done", "merged acme/app#1", "--brief", join(state.dir, "b.md"), "--note", "x"]);
  expect(notes.code).toBe(1);
  expect(notes.err).toContain("--note goes with --from-message");
});

test("launch --from-message with an unknown id exits 1 naming it and writes no brief", async () => {
  mkdirSync(join(state.dir, "state"), { recursive: true });
  const r = await cli(["k1", "--title", "t", "--done", "merged acme/app#1", "--from-message", "111", "999"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("message 999 in channel 111 is not in the local inbox");
  expect(existsSync(join(state.dir, "state", "briefs"))).toBe(false);
});

test("a generated brief launches in mass-ulw mode: its path has no '?' and the footer is appended", async () => {
  log("discord:111:501", "INBOUND 111 501 owner investigate the flaky upload");
  const path = generatedBriefPath(state.dir, "mass-lane");
  expect(path).toBe(join(state.dir, "briefs", "mass-lane.md"));
  writeGeneratedBrief(path, assembleBrief("Upload", [ownerMessageText(state.dir, { channel: "111", message: "501" })], []));
  world.panes = [];
  const d = depsFor(world, fakeClock(T0), state.dir);
  const r = await launchLane(d, { key: "mass-lane", title: "Upload", brief: path, done: "closed acme/app#3", mode: "mass-ulw", cwd: state.dir });
  expect(r.lane.mode).toBe("mass-ulw");
  const start = world.ops.find((e) => e.op === "start")?.args as { keywords: string; mode: string; briefText: string } | undefined;
  expect(start).toMatchObject({ keywords: "/mass-ulw set goal and work", mode: "mass-ulw" });
  expect(start?.briefText).toContain("## Lane footer (written by dori launch)");
  expect(r.lane.brief).toBe(path);
  const text = await Bun.file(path).text();
  expect(text).toStartWith("# Upload\n\n## Owner request\n\ninvestigate the flaky upload\n");
  expect(text).toContain("## Lane footer (written by dori launch)");
});
