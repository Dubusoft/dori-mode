import { expect, test } from "bun:test";

import { pidAlive } from "../src/heavy-slot.ts";

test("pidAlive considers the current process alive", () => {
  expect(pidAlive(process.pid)).toBe(true);
});

test("pidAlive considers an impossible pid dead", () => {
  expect(pidAlive(2_147_483_647)).toBe(false);
});
