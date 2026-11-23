import { expect, test } from "bun:test";
import { join } from "node:path";
import { withState } from "./fakes.ts";

const cli = async (home: string, args: string[]) => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, DORI_CONFIG: join(home, "missing.json"), DORI_STATE_DIR: join(home, "state") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
};

const inState = async (fn: (dir: string) => Promise<void>) => {
  const state = withState();
  try { await fn(state.dir); } finally { state.done(); }
};

for (const loop of [["--loop", "abc"], ["--loop", "-1"], ["--loop"]]) {
  test(`dori freshness ${loop.join(" ")} is a usage error instead of a loop`, () => inState(async (dir) => {
    const r = await cli(dir, ["freshness", ...loop]);
    expect(r.code).toBe(2);
    expect(r.err).toStartWith("usage: dori freshness [--loop MIN]");
  }));
}

test("an unknown flag is refused before the command runs, a known one is not", () => inState(async (dir) => {
  const typo = await cli(dir, ["close", "nolane", "--forse"]);
  expect(typo.code).toBe(2);
  expect(typo.err).toContain("unknown option --forse");
  const known = await cli(dir, ["close", "nolane", "--force"]);
  expect(known.code).toBe(1);
  expect(known.err).toContain('no registered lane "nolane"');
}));

test("a command with its own flag parser keeps its flags", () => inState(async (dir) => {
  const r = await cli(dir, ["handled", "1", "2", "--tasks", "3"]);
  expect(r.err).not.toContain("unknown option");
  expect(r.err).toContain("handled needs --lane <key>");
}));
