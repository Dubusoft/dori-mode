import { expect, test } from "bun:test";
import { SecretStoreError } from "../src/secret-store.ts";
import { repoFromRemote, secretGranter } from "../src/runner/secret-grant.ts";

test("every value is granted and registered for masking", async () => {
  const values = new Map([["GH_TOKEN", "throwaway"], ["API_KEY", "other"]]);
  const masked: string[] = [];
  const grant = secretGranter({ store: { readAll: async () => values, read: async (name) => values.get(name) as string }, onGranted: (v) => { masked.push(...v); } });
  expect(await grant("any-lane")).toEqual({ ok: true, values: Object.fromEntries(values) });
  expect(masked).toEqual([...values.values()]);
  expect(await grant("older-runner", ["API_KEY"])).toEqual({ ok: true, values: { API_KEY: "other" } });
});

test("missing legacy names and store failures refuse without values", async () => {
  const grant = secretGranter({ store: { readAll: async () => { throw new Error("unreadable"); }, read: async () => { throw new SecretStoreError("SECRET_MISSING", "missing"); } } });
  expect(await grant("lane")).toEqual({ ok: false, code: "RUNNER_SECRET_FAILED", detail: "unreadable" });
  expect(await grant("lane", ["MISSING"])).toMatchObject({ ok: false, code: "RUNNER_SECRET_MISSING" });
});

test("repoFromRemote parses https, scp-like and ssh:// remotes", () => {
  expect(repoFromRemote("https://github.com/Dubusoft/dori-mode.git")).toBe("Dubusoft/dori-mode");
  expect(repoFromRemote("https://github.com/o/r")).toBe("o/r");
  expect(repoFromRemote("git@github.com:o/r.git")).toBe("o/r");
  expect(repoFromRemote("ssh://git@host.example/o/r.git")).toBe("o/r");
  expect(repoFromRemote("/local/path/repo")).toBeUndefined();
  expect(repoFromRemote("https://github.com/only-owner")).toBeUndefined();
});
