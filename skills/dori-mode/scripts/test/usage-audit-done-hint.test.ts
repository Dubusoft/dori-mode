import { expect, test } from "bun:test";

import { parseSignal, SignalSyntaxError, UNREADABLE } from "../src/signals.ts";

test("merged text without a repository PR number gets an actionable hint", () => {
  expect(() => parseSignal("merged dev-bokdong/dori-mode PR into dev")).toThrow(
    `${UNREADABLE} merged needs a PR number (merged <owner>/<repo>#N); if the PR does not exist yet, launch with the issue's closed <owner>/<repo>#M, or add the PR to Done later.`,
  );
});

test("closed text without a repository issue number gets the near-miss hint", () => {
  expect(() => parseSignal("closed the issue")).toThrow(
    /merged needs a PR number \(merged <owner>\/<repo>#N\)/,
  );
});

test("other unreadable text keeps the existing message", () => {
  try {
    parseSignal("something else");
    throw new Error("expected parseSignal to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(SignalSyntaxError);
    expect((error as Error).message).toBe(UNREADABLE);
  }
});
