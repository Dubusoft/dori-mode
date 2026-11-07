import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectUnix, listenUnix } from "../src/runner/unix-transport.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const tempSockDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "win-unix-transport-"));
  dirs.push(dir);
  const sock = join(dir, "sock");
  mkdirSync(sock);
  return sock;
};

test("listenUnix and connectUnix reject paths longer than 107 UTF-8 bytes", () => {
  const tooLong = `${"a".repeat(105)}é`;
  expect(Buffer.byteLength(tooLong, "utf8")).toBe(107);
  expect(() => listenUnix(`${tooLong}x`, "win32")).toThrow("RUNNER_SOCKET_PATH_TOO_LONG");
  expect(() => connectUnix(`${tooLong}x`, "win32")).toThrow("RUNNER_SOCKET_PATH_TOO_LONG");
});

test("win32 listener unlinks a stale symlink under sock before listening", () => {
  const sock = tempSockDir();
  const target = join(sock, "target");
  const path = join(sock, "lane");
  writeFileSync(target, "target");
  symlinkSync(target, path);

  const listener = listenUnix(path, "win32");
  try {
    expect(existsSync(path)).toBe(true);
  } finally {
    listener.close();
  }
});
