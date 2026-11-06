import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { LaunchError, launchNextLine, validateLaunch } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
let home: string; // a temp home whose .dori/state is the config stateDir: the real ~/.dori is never touched
beforeEach(() => {
  state = withState();
  home = join(state.dir, "home");
  mkdirSync(join(home, ".dori", "state"), { recursive: true });
});
afterEach(() => {
  state.done();
});

test("launchNextLine reports unconfirmed and error startup", () => {
  const expected = "LAUNCH_NEXT the lane is registered; cancel it with dori close test-key --cancelled --reason TEXT before relaunching";
  expect(launchNextLine("test-key", "STARTUP_UNCONFIRMED")).toBe(expected);
  expect(launchNextLine("test-key", "STARTUP_ERROR")).toBe(expected);
});

test("launchNextLine omits follow-up for successful startup", () => {
  expect(launchNextLine("test-key", "STARTUP_OK pane")).toBeUndefined();
});

const deps = (which: (cmd: string) => string | null = () => "/bin/lane-sandbox") => {
  const base = depsFor(newWorld(), fakeClock(Date.parse("2026-01-01T12:00:00.000Z")), join(home, ".dori", "state"));
  return { ...base, which, config: { ...base.config, stateDir: join(home, ".dori", "state"), laneSandbox: { command: ["lane-sandbox"] }, defaultCwd: join(home, "work", "main") } } as typeof base;
};
const input = (extra: Record<string, string | true> = {}) => ({ key: "cwd-lane", title: "t", brief: join(state.dir, "brief.md"), done: "closed acme/app#3", ...extra });

test("a sandboxed local launch with --cwd inside ~/.dori is refused with a worktree hint", async () => {
  const attempt = validateLaunch(deps(), input({ cwd: join(home, ".dori", "worktrees", "default-platform") }));
  await expect(attempt).rejects.toBeInstanceOf(LaunchError);
  await expect(attempt).rejects.toThrow(`is inside ${join(home, ".dori")}, which the lane sandbox cannot bind; put the worktree outside it (e.g. under ${join(home, "work")})`);
});

test("--cwd outside ~/.dori, inside the bound state dir, --machine, --pane and a missing sandbox command all pass", async () => {
  const inDori = join(home, ".dori", "worktrees", "x");
  await validateLaunch(deps(), input({ cwd: join(home, "work", "wt") }));
  await validateLaunch(deps(), input({ cwd: join(home, ".dori", "state", "wt") }));
  await validateLaunch(deps(), input({ cwd: inDori, machine: "box" }));
  await validateLaunch(deps(), input({ cwd: inDori, pane: "w:p3" }));
  await validateLaunch(deps(() => null), input({ cwd: inDori }));
});

test("--sandbox makes a --pane launch inside ~/.dori refused", async () => {
  await expect(validateLaunch(deps(), input({ cwd: join(home, ".dori", "wt"), pane: "w:p3", sandbox: true }))).rejects.toThrow(/lane sandbox cannot bind/);
});
