import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labelFromHost, parseInstallTarget, readRunnerMachines, RUNNER_MACHINES_FILE, writeRunnerMachine } from "../src/runner/machines.ts";
import { LABEL_PATTERN } from "../src/runner/protocol.ts";

test("parseInstallTarget accepts user@ip, ip, user@host and host", () => {
  expect(parseInstallTarget("ubuntu@100.64.1.2")).toEqual({ target: "ubuntu@100.64.1.2", host: "100.64.1.2" });
  expect(parseInstallTarget("100.64.1.2").host).toBe("100.64.1.2");
  expect(parseInstallTarget("me@mini.lan").host).toBe("mini.lan");
  expect(parseInstallTarget("mini").host).toBe("mini");
  expect(parseInstallTarget("me@[fd12::1]").host).toBe("[fd12::1]");
});

test("parseInstallTarget rejects empty targets, ssh options and malformed parts", () => {
  for (const bad of ["", "@", "me@", "@host", "-oProxyCommand=x", "me@-oProxyCommand=x", "-l", "a b", "me@a b", "host;rm", "a@b@c", "host:22", "-"]) {
    expect(() => parseInstallTarget(bad), bad).toThrow("RUNNER_TARGET_INVALID");
  }
});

test("labelFromHost makes a LABEL_PATTERN-safe slug of the host", () => {
  expect(labelFromHost("100.64.1.2")).toBe("100-64-1-2");
  expect(labelFromHost("mini.lan")).toBe("mini-lan");
  expect(labelFromHost("Mini.LAN")).toBe("mini-lan");
  expect(labelFromHost("[fd12::1]")).toBe("fd12-1");
  expect(LABEL_PATTERN.test(labelFromHost("a".repeat(63)))).toBe(true);
  expect(() => labelFromHost("a".repeat(70))).toThrow("RUNNER_TARGET_INVALID");
  expect(() => labelFromHost("...")).toThrow("RUNNER_TARGET_INVALID");
});

test("runner-machines.json keeps other labels, is mode 0600 and a bad file reads as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "dori-rm-"));
  try {
    expect(readRunnerMachines(dir)).toEqual({});
    writeRunnerMachine(dir, "a", "me@1.2.3.4");
    writeRunnerMachine(dir, "b", "mini");
    writeRunnerMachine(dir, "a", "me@1.2.3.5");
    expect(readRunnerMachines(dir)).toEqual({ a: "me@1.2.3.5", b: "mini" });
    expect(statSync(join(dir, RUNNER_MACHINES_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, RUNNER_MACHINES_FILE), "utf8"))).toEqual({ a: "me@1.2.3.5", b: "mini" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
