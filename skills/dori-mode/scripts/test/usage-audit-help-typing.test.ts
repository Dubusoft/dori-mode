import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withState } from "./fakes.ts";

const cli = async (home: string, args: string[]) => {
  const preload = join(home, "fake-fetch.js");
  writeFileSync(preload, 'globalThis.fetch = async (u) => { console.log("FAKE_CALL " + u); return new Response(JSON.stringify({}), { status: 200 }); };');
  const child = Bun.spawn(["bun", "--preload", preload, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      DORI_CONFIG: join(home, "missing.json"),
      DORI_STATE_DIR: join(home, "state"),
      DORI_DISCORD_TOKEN: "t",
    },
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

for (const flag of ["--help", "-h"]) {
  test(`dori launch ${flag} prints only launch usage and exits successfully`, () => inState(async (dir) => {
    const r = await cli(dir, ["launch", flag]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("  launch <key>");
    expect(r.out).toContain("                [--from-message CHANNEL MESSAGE_ID]");
    expect(r.out).not.toContain("  adopt ");
    expect(r.err).toBe("");
  }));
}

test("dori typing accepts an implicit Discord target", () => inState(async (dir) => {
  const r = await cli(dir, ["typing", "123"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("FAKE_CALL https://discord.com/api/v10/channels/123/typing");
  expect(r.out).toContain("TYPING discord 123 on");
}));

test("dori typing keeps the explicit Discord platform form", () => inState(async (dir) => {
  const r = await cli(dir, ["typing", "discord", "123"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("FAKE_CALL https://discord.com/api/v10/channels/123/typing");
  expect(r.out).toContain("TYPING discord 123 on");
}));

test("dori setup --help prints setup-specific help and exits successfully", () => inState(async (dir) => {
  const r = await cli(dir, ["setup", "--help"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("GitHub repos are optional; setup reads and saves this machine's watched list.");
  expect(r.err).toBe("");
}));

test("send, thread, typing and presence usage make Discord optional", async () => {
  const cliSource = await Bun.file(join(import.meta.dir, "../src/cli.ts")).text();
  expect(cliSource).toMatch(/send \[discord\]/);
  expect(cliSource).toMatch(/thread \[discord\]/);
  expect(cliSource).toMatch(/typing \[discord\]/);
  expect(cliSource).toMatch(/presence \[discord\]/);
});
