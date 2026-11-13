import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretRule } from "../src/config.ts";
import { SecretStore } from "../src/secret-store.ts";
import { laneCliMain } from "../src/runner/lane-cli.ts";
import { type LaneSocketLanes, SECRET_PUT_MAX_BYTES, serveLaneSocket } from "../src/runner/lane-socket.ts";
import type { RunnerEventType } from "../src/runner/protocol.ts";
import { type SecretAuditEntry, secretDepositor, secretGranter } from "../src/runner/secret-grant.ts";
import { type Connector, memoryNetwork, type Transport } from "../src/runner/transport.ts";

const VALUE = "dori-test-throwaway-123";
const env = { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN: "tok-a", PATH: "/bin" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), "dori-secret-put-")); dirs.push(dir); return dir; };

/**
 * The local runner's lane socket over an in-memory link, with the production depositor and granter on a real store
 * (plain backend: systemd-creds reported missing) in a temp dir.
 */
const runner = (rules: Record<string, SecretRule>) => {
  const store = new SecretStore({ dir: join(tempDir(), "secrets"), run: async () => ({ code: 1, out: "", err: "no systemd-creds" }) });
  const audit: SecretAuditEntry[] = [];
  const logs: string[] = [];
  const published: [RunnerEventType, unknown][] = [];
  let puts = 0;
  const common = { rules: async () => rules, laneRepo: async () => undefined, audit: (e: SecretAuditEntry) => { audit.push(e); }, runner: "local", now: () => 0 };
  const depositor = secretDepositor({ ...common, store });
  const lanes: LaneSocketLanes = {
    tokenFor: (key, token) => (key === "lane-a" && token === "tok-a") || (key === "lane-b" && token === "tok-b"),
    secrets: secretGranter({ ...common, store }),
    secretPut: async (key, name, value) => { puts++; return depositor(key, name, value); },
  };
  const net = memoryNetwork();
  serveLaneSocket(net.listener, lanes, (type, body) => { published.push([type, body]); }, (l) => { logs.push(l); });
  // The reply is async (a store write), so the connector keeps pumping until it settles.
  const connect: Connector = async () => {
    const link = await net.connect();
    const pair = net.pairs.at(-1) as (typeof net.pairs)[number];
    return {
      send: (line) => { link.send(line); pair.pump(); void (async () => { for (let i = 0; i < 50; i++) { await new Promise((r) => setImmediate(r)); pair.pump(); } })(); },
      onLine: (h) => link.onLine(h), onClose: (h) => link.onClose(h), close: (reason) => { link.close(reason); },
      get open() { return link.open; },
    } satisfies Transport;
  };
  const cli = async (args: readonly string[], opts: { stdin?: string; lane?: Record<string, string> } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const spawned: Record<string, string>[] = [];
    const files: Record<string, { text: string; mode: number }> = {};
    const code = await laneCliMain(args, {
      env: opts.lane ?? env, connect, out: (l) => { out.push(l); }, err: (l) => { err.push(l); }, tempRoot: tempDir(),
      readStdin: async () => opts.stdin ?? "",
      spawnWithEnv: async (_argv, childEnv) => {
        spawned.push(childEnv);
        for (const [name, path] of Object.entries(childEnv)) {
          if (rules[name]?.as === "file") files[name] = { text: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777 };
        }
        return 0;
      },
    });
    return { code, out, err, spawned, files };
  };
  return { store, audit, logs, published, cli, puts: () => puts };
};

test("an allowed lane stores a value from stdin; the same lane's exec is refused unless the rule also grants it", async () => {
  const r = runner({ UPLOAD_KEY: { lanes: ["lane-b"], repos: [], put: { lanes: ["lane-a"], repos: [] } } });
  const put = await r.cli(["secret", "put", "UPLOAD_KEY"], { stdin: `${VALUE}\n` });
  expect(put).toMatchObject({ code: 0, out: ["SECRET_STORED UPLOAD_KEY backend=plain"], err: [] });
  // One trailing newline is dropped, as for dori secret add.
  expect(await r.store.read("UPLOAD_KEY")).toBe(VALUE);
  expect(r.audit).toEqual([{ at: "1970-01-01T00:00:00.000Z", runner: "local", lane: "lane-a", names: ["UPLOAD_KEY"], allowed: true, put: true }]);

  const exec = await r.cli(["secret", "exec", "UPLOAD_KEY", "--", "true"]);
  expect(exec.code).toBe(1);
  expect(exec.err).toEqual(["RUNNER_SECRET_DENIED lane-a may not receive UPLOAD_KEY (config secrets)"]);
  expect(exec.spawned).toEqual([]);
  const other = await r.cli(["secret", "exec", "UPLOAD_KEY", "--", "true"], { lane: { DORI_LANE_KEY: "lane-b", DORI_LANE_TOKEN: "tok-b" } });
  expect(other.code).toBe(0);
  expect(other.spawned[0]?.UPLOAD_KEY).toBe(VALUE);

  const again = await r.cli(["secret", "put", "UPLOAD_KEY"], { stdin: `${VALUE}-2` });
  expect(again.out).toEqual(["SECRET_REPLACED UPLOAD_KEY backend=plain"]);
  expect(r.published).toEqual([]);
  expect([...put.out, ...put.err, ...exec.err, ...again.out, ...r.logs, JSON.stringify(r.audit)].join("\n")).not.toContain(VALUE);
});

test("a name without put, or whose put names another lane, is refused and nothing is stored", async () => {
  const r = runner({ READ_ONLY: { lanes: ["lane-a"], repos: [] }, THEIRS: { lanes: [], repos: [], put: { lanes: ["lane-b"], repos: [] } } });
  for (const name of ["READ_ONLY", "THEIRS", "UNLISTED"]) {
    const res = await r.cli(["secret", "put", name], { stdin: VALUE });
    expect(res.code).toBe(1);
    expect(res.err).toEqual([`RUNNER_SECRET_DENIED lane-a may not store ${name} (config secrets.${name}.put)`]);
  }
  expect(r.store.list()).toEqual([]);
  expect(r.audit.map((e) => [e.names[0], e.allowed, e.reason])).toEqual([
    ["READ_ONLY", false, "put not allowed: READ_ONLY"], ["THEIRS", false, "put not allowed: THEIRS"], ["UNLISTED", false, "put not allowed: UNLISTED"],
  ]);
});

test("a file secret a lane stored reaches an allowed exec as a 0600 file holding the exact value", async () => {
  const r = runner({ SA_JSON: { lanes: ["lane-a"], repos: [], as: "file", put: { lanes: ["lane-a"], repos: [] } } });
  const json = `{"type":"service_account","private_key":"${VALUE}"}`;
  expect((await r.cli(["secret", "put", "SA_JSON"], { stdin: json })).code).toBe(0);
  const exec = await r.cli(["secret", "exec", "SA_JSON", "--", "true"]);
  expect(exec.code).toBe(0);
  expect(exec.spawned[0]?.SA_JSON).not.toContain(VALUE);
  expect(exec.files.SA_JSON).toEqual({ text: json, mode: 0o600 });
  expect(exec.spawned[0]?.GIT_SSH_COMMAND).toBeUndefined();
});

test("put usage: no name, a bad name, empty or oversized stdin exit 2 without asking the runner", async () => {
  const r = runner({});
  const cases: [readonly string[], string, string][] = [
    [["secret", "put"], VALUE, "usage: dori secret put NAME"],
    [["secret", "put", "lower"], VALUE, "usage: dori secret put NAME"],
    [["secret", "put", "A", "B"], VALUE, "usage: dori secret put NAME"],
    [["secret", "put", "A"], "\n", "SECRET_VALUE_EMPTY"],
    [["secret", "put", "A"], "x".repeat(SECRET_PUT_MAX_BYTES + 1), "SECRET_VALUE_TOO_LARGE"],
  ];
  for (const [args, stdin, message] of cases) {
    const res = await r.cli(args, { stdin });
    expect(res.code).toBe(2);
    expect(res.err[0]).toStartWith(message);
  }
  expect(r.puts()).toBe(0);
});

test("another lane's token is refused before anything is stored, and the log carries no value", async () => {
  const r = runner({ UPLOAD_KEY: { lanes: [], repos: [], put: { lanes: ["lane-a"], repos: [] } } });
  const res = await r.cli(["secret", "put", "UPLOAD_KEY"], { stdin: VALUE, lane: { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN: "tok-b" } });
  expect(res.code).toBe(1);
  expect(res.err[0]).toStartWith("RUNNER_LANE_AUTH_FAILED");
  expect(r.puts()).toBe(0);
  expect(r.logs).toEqual(["RUNNER_LANE_AUTH_FAILED key=lane-a verb=secret-put"]);
  expect(r.store.list()).toEqual([]);
});
