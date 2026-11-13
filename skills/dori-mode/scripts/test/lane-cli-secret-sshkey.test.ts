import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { laneCliMain } from "../src/runner/lane-cli.ts";
import type { Connector, Transport } from "../src/runner/transport.ts";

const KEY_A = "dori-test-throwaway-123";
const KEY_B = "dori-test-throwaway-456";
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const env = { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN: "tok-a" };
/** A temp root whose path holds a space, so GIT_SSH_COMMAND must quote the key path. */
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), "dori sshkey test-")); roots.push(dir); return dir; };

/** A lane socket that answers the one request with a canned grant reply. */
const grant = (reply: object): Connector => async () => {
  let line: (l: string) => void = () => {};
  return {
    send: () => { line(JSON.stringify(reply)); },
    onLine: (h) => { line = h; return () => {}; },
    onClose: () => () => {},
    close: () => {},
    open: true,
  } satisfies Transport;
};

type Seen = { env: Record<string, string>; files: Record<string, { text: string; mode: number }>; dir: string | undefined };
const run = async (reply: object, spawnThrows = false) => {
  const tempRoot = root();
  const seen: Seen = { env: {}, files: {}, dir: undefined };
  const code = laneCliMain(["secret", "exec", "KEY_A", "KEY_B", "--", "git", "fetch"], {
    env, connect: grant(reply), out: () => {}, err: () => {}, tempRoot,
    spawnWithEnv: async (_argv, childEnv) => {
      seen.env = childEnv;
      for (const name of ["KEY_A", "KEY_B"]) {
        const path = childEnv[name];
        if (path && existsSync(path)) {
          seen.dir = dirname(path);
          seen.files[name] = { text: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777 };
        }
      }
      if (seen.dir) seen.files.__dir = { text: "", mode: statSync(seen.dir).mode & 0o777 };
      if (spawnThrows) throw new Error("spawn failed");
      return 7;
    },
  });
  return { code: spawnThrows ? await code.catch((e: Error) => e.message) : await code, seen, tempRoot };
};

test("one ssh-key secret: path in env, key in a 0600 file, GIT_SSH_COMMAND set, dir removed", async () => {
  const { code, seen, tempRoot } = await run({ ok: true, values: { KEY_A }, kinds: { KEY_A: "ssh-key" } });
  expect(code).toBe(7);
  const path = seen.env.KEY_A as string;
  expect(path).not.toContain(KEY_A);
  expect(Object.values(seen.env)).not.toContain(KEY_A);
  expect(seen.files.KEY_A).toEqual({ text: `${KEY_A}\n`, mode: 0o600 });
  expect(seen.files.__dir?.mode).toBe(0o700);
  expect(path).toContain(" ");
  expect(seen.env.GIT_SSH_COMMAND).toBe(`ssh -i '${path}' -o IdentitiesOnly=yes -o IdentityAgent=none`);
  expect(existsSync(dirname(path))).toBe(false);
  expect(readdirSync(tempRoot)).toEqual([]);
});

test("a value with a trailing newline keeps just one", async () => {
  const { seen } = await run({ ok: true, values: { KEY_A: `${KEY_A}\n` }, kinds: { KEY_A: "ssh-key" } });
  expect(seen.files.KEY_A?.text).toBe(`${KEY_A}\n`);
});

test("two ssh-key secrets: two paths, no GIT_SSH_COMMAND, dir removed", async () => {
  const { seen, tempRoot } = await run({ ok: true, values: { KEY_A, KEY_B }, kinds: { KEY_A: "ssh-key", KEY_B: "ssh-key" } });
  expect(seen.env.KEY_A).not.toBe(seen.env.KEY_B);
  expect(seen.files.KEY_A?.text).toBe(`${KEY_A}\n`);
  expect(seen.files.KEY_B?.text).toBe(`${KEY_B}\n`);
  expect(seen.env.GIT_SSH_COMMAND).toBeUndefined();
  expect(readdirSync(tempRoot)).toEqual([]);
});

test("a file secret: path in env, value written byte for byte in a 0600 file, no GIT_SSH_COMMAND, dir removed", async () => {
  const json = `{"key":"${KEY_A}"}`;
  const { seen, tempRoot } = await run({ ok: true, values: { KEY_A: json }, kinds: { KEY_A: "file" } });
  expect(seen.env.KEY_A).not.toContain(KEY_A);
  expect(seen.files.KEY_A).toEqual({ text: json, mode: 0o600 });
  expect(seen.files.__dir?.mode).toBe(0o700);
  expect(seen.env.GIT_SSH_COMMAND).toBeUndefined();
  expect(readdirSync(tempRoot)).toEqual([]);
});

test("one ssh-key next to a file secret still sets GIT_SSH_COMMAND for the key", async () => {
  const { seen } = await run({ ok: true, values: { KEY_A, KEY_B }, kinds: { KEY_A: "ssh-key", KEY_B: "file" } });
  expect(seen.files.KEY_A?.text).toBe(`${KEY_A}\n`);
  expect(seen.files.KEY_B?.text).toBe(KEY_B);
  expect(seen.env.GIT_SSH_COMMAND).toBe(`ssh -i '${seen.env.KEY_A}' -o IdentitiesOnly=yes -o IdentityAgent=none`);
});

test("env-kind secrets stay plain env values and make no temp dir", async () => {
  const { seen, tempRoot } = await run({ ok: true, values: { KEY_A } });
  expect(seen.env.KEY_A).toBe(KEY_A);
  expect(seen.env.GIT_SSH_COMMAND).toBeUndefined();
  expect(seen.dir).toBeUndefined();
  expect(readdirSync(tempRoot)).toEqual([]);
});

test("the dir is removed when spawning throws", async () => {
  const { code, seen, tempRoot } = await run({ ok: true, values: { KEY_A }, kinds: { KEY_A: "ssh-key" } }, true);
  expect(code).toBe("spawn failed");
  expect(seen.dir).toBeDefined();
  expect(existsSync(seen.dir as string)).toBe(false);
  expect(readdirSync(tempRoot)).toEqual([]);
});
