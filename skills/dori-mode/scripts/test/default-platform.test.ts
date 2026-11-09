import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withState } from "./fakes.ts";

const cli = async (home: string, args: string[], env: Record<string, string> = { DORI_DISCORD_TOKEN: "t" }) => {
  const preload = join(home, "fake-fetch.js");
  writeFileSync(preload, 'globalThis.fetch = async (u) => { console.log("FAKE_CALL " + u); return new Response(JSON.stringify({ id: "9" }), { status: 200 }); };');
  const child = Bun.spawn(["bun", "--preload", preload, join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, DORI_CONFIG: join(home, "missing.json"), DORI_STATE_DIR: join(home, "state"), ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
};

const inState = async (fn: (dir: string) => Promise<void>) => {
  const state = withState();
  try { await fn(state.dir); } finally { state.done(); }
};

for (const platform of [[], ["discord"]]) {
  const label = platform.length ? "discord named" : "platform omitted";
  test(`dori send posts to Discord with the ${label}`, () => inState(async (dir) => {
    const r = await cli(dir, ["send", ...platform, "--to", "123", "--text", "x"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("FAKE_CALL https://discord.com/api/v10/channels/123/messages");
    expect(r.out).toContain("SENT 9");
  }));

  test(`dori thread starts a Discord thread with the ${label}`, () => inState(async (dir) => {
    const r = await cli(dir, ["thread", ...platform, "--to", "123", "--name", "n"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("THREAD discord:123/9");
  }));

  test(`dori presence takes the Discord path with the ${label}`, () => inState(async (dir) => {
    const r = await cli(dir, ["presence", ...platform], {});
    expect(r.code).toBe(1);
    expect(r.err).toContain("DORI_DISCORD_TOKEN is not set");
  }));
}

for (const command of [["send", "slack", "--to", "123", "--text", "x"], ["thread", "slack", "--to", "123", "--name", "n"], ["presence", "slack"]]) {
  test(`dori ${command[0]} refuses an unknown platform and calls nothing`, () => inState(async (dir) => {
    const r = await cli(dir, command);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown platform slack");
    expect(r.out).not.toContain("FAKE_CALL");
  }));
}
