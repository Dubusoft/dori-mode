import { afterAll } from "bun:test";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Hermetic test env: drop ambient dori-lane / herdr host variables so tests never
// inherit the identity, permissions, or live herdr pane of the lane running them.
// Tests that need these vars set them explicitly themselves.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("HERDR_") || key.startsWith("DORI_")) delete process.env[key];
}

// Fake-clock tests keep their durable state in memory: each store save fsyncs a file and its
// directory, and on a busy disk those stalls alone can use up a test's 5 s deadline.
// Without a writable /dev/shm the tests keep the inherited TMPDIR.
const memoryFs = "/dev/shm";
const writable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
if (writable(memoryFs)) {
  const dir = mkdtempSync(join(memoryFs, "dori-test-"));
  process.env.TMPDIR = dir;
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
}
