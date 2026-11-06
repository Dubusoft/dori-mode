import { expect, test } from "bun:test";
import { join } from "node:path";
import { withState } from "./fakes.ts";

const cli = async (home: string, args: string[]) => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: process.env.TMPDIR ?? home, DORI_CONFIG: join(home, "missing.json"), DORI_STATE_DIR: home },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
};

test("close --reason without --cancelled errors before touching the registry", async () => {
  const state = withState();
  try {
    const r = await cli(state.dir, ["close", "missing-lane", "--reason", "abandoned"]);
    expect(r.code).toBe(1);
    expect(r.err.trim()).toBe("--reason goes with --cancelled: dori close <key> --cancelled --reason TEXT");
    expect(r.out).toBe("");
  } finally { state.done(); }
});
