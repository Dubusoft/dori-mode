import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { bskDaemonSocket, startBrowserProxy, type BrowserExchangeResult, type BrowserProxy } from "../src/runner/browser-proxy.ts";

type Script = { origin: string; top: boolean; masked: boolean };
type Box = { buf: Buffer; out: Buffer[] };

const SCREENSHOT_BYTES = 1536 * 1024;

const pump = (s: Socket<Box>): void => {
  while (s.data.out.length > 0) {
    const chunk = s.data.out[0]!;
    const n = s.write(chunk);
    if (n < chunk.length) { if (n > 0) s.data.out[0] = chunk.subarray(n); return; }
    s.data.out.shift();
  }
};

/** A fake BrowserSkill daemon: NDJSON, scripted target, records the methods and the fill values it gets. */
const fakeDaemon = (path: string, script: Script, value: () => string) => {
  const methods: string[] = [];
  const fills: unknown[] = [];
  const answer = (req: { id: unknown; method: string; params: Record<string, unknown> }): unknown => {
    methods.push(req.method);
    switch (req.method) {
      case "tool.cooperate": return { id: req.id, result: { context_id: `ctx-${methods.length}` } };
      case "tool.evaluate": return { id: req.id, result: { value: { ...script } } };
      case "tool.fill": fills.push(req.params.value); return { id: req.id, result: { ok: true, echoed: req.params.value } };
      case "tool.get_html": {
        const b = Buffer.from(value());
        return { id: req.id, result: { html: `<p>${value()}</p><i>${b.toString("base64")}</i><b>${b.toString("hex")}</b><u>${b.toString("base64url")}</u><s>${encodeURIComponent(value())}</s>` } };
      }
      case "tool.screenshot": return { id: req.id, result: { data: "A".repeat(SCREENSHOT_BYTES) } };
      case "session.stop": return { id: req.id, result: { ok: true } };
      default: return { id: req.id, error: { code: "unknown_method", message: req.method, data: {} } };
    }
  };
  const server = Bun.listen<Box>({
    unix: path,
    socket: {
      open: (s) => { s.data = { buf: Buffer.alloc(0), out: [] }; },
      data: (s, chunk) => {
        s.data.buf = Buffer.concat([s.data.buf, chunk]);
        for (let i = s.data.buf.indexOf(10); i >= 0; i = s.data.buf.indexOf(10)) {
          const req = JSON.parse(s.data.buf.subarray(0, i).toString());
          s.data.buf = s.data.buf.subarray(i + 1);
          s.data.out.push(Buffer.from(`${JSON.stringify(answer(req))}\n`));
          pump(s);
        }
      },
      drain: pump,
    },
  });
  return { methods, fills, stop: () => server.stop(true) };
};

/** Sends `lines` in one write (split across the given chunks when asked) and resolves with the first `count` reply lines. */
const ask = (sock: string, lines: string[], count = lines.length): Promise<string[]> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let done = false;
  const text = lines.map((l) => `${l}\n`).join("");
  Bun.connect<undefined>({
    unix: sock,
    socket: {
      open: (s) => {
        // Split mid-line so the proxy must reassemble requests.
        const cut = Math.floor(text.length / 2);
        s.write(text.slice(0, cut));
        s.write(text.slice(cut));
      },
      data: (s, chunk) => {
        chunks.push(chunk);
        const all = Buffer.concat(chunks).toString();
        const got = all.split("\n").slice(0, -1);
        if (got.length >= count && !done) { done = true; s.end(); resolve(got.slice(0, count)); }
      },
      close: () => { if (!done) reject(new Error("closed early")); },
    },
  }).catch(reject);
});

const req = (id: number, method: string, params: Record<string, unknown> = {}): string => JSON.stringify({ id, method, params });

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.reverse()) await f();
  cleanup = [];
});

const setup = (script: Script, grant: BrowserExchangeResult | ((handle: string, origin: string) => BrowserExchangeResult) = { ok: true, value: "" }) => {
  const root = mkdtempSync(join(tmpdir(), "bfp-"));
  const value = `pw-${randomBytes(12).toString("base64url")}/+&?`;
  const handle = `dsh_${randomBytes(32).toString("base64url")}`;
  const daemonSock = join(root, "real.sock");
  const daemon = fakeDaemon(daemonSock, script, () => value);
  const exchanges: { handle: string; origin: string }[] = [];
  const logs: string[] = [];
  let upstream: string | undefined = daemonSock;
  const dir = join(root, "browser", "lane-a");
  const proxy: BrowserProxy = startBrowserProxy({
    key: "lane-a",
    dir,
    upstream: () => upstream,
    exchange: async (h, origin) => {
      exchanges.push({ handle: h, origin });
      const g = typeof grant === "function" ? grant(h, origin) : grant;
      return g.ok && g.value === "" ? { ok: true, value } : g;
    },
    log: (line) => logs.push(line),
    pid: 4242,
  });
  cleanup.push(() => daemon.stop(), () => proxy.stop(), () => rmSync(root, { recursive: true, force: true }));
  return { root, dir, value, handle, daemon, proxy, exchanges, logs, setUpstream: (p: string | undefined) => { upstream = p; } };
};

const parse = (line: string) => JSON.parse(line) as { id: unknown; result?: Record<string, unknown>; error?: { code: string; message: string; data: { reason?: string; effect_state: string } } };
const LOG_LINE = /^RUNNER_BROWSER lane=lane-a method=[\x21-\x7e]+ decision=(forward|allow|refuse:[a-z_]+)( origin=[\x21-\x7e]+)?$/;
const PASSWORD: Script = { origin: "https://login.example.com", top: true, masked: true };

describe("browser fill proxy", () => {
  test("an allowed fill forwards the real value and the reply carries none", async () => {
    const t = setup(PASSWORD);
    const [reply] = await ask(t.proxy.sockPath, [req(1, "tool.fill", { selector: "#pw", value: t.handle })]);
    expect(t.daemon.fills).toEqual([t.value]);
    expect(t.exchanges).toEqual([{ handle: t.handle, origin: PASSWORD.origin }]);
    expect(t.daemon.methods).toEqual(["tool.cooperate", "tool.evaluate", "tool.cooperate", "tool.fill"]);
    expect(reply).not.toContain(t.value);
    expect(parse(reply!)).toEqual({ id: 1, result: { ok: true, echoed: "[REDACTED]" } });
    expect(t.logs).toEqual([`RUNNER_BROWSER lane=lane-a method=tool.fill decision=allow origin=${PASSWORD.origin}`]);
  });

  for (const [name, script] of [["non-password", { ...PASSWORD, masked: false }], ["non-top", { ...PASSWORD, top: false }]] as const) {
    test(`a ${name} target is refused without an exchange`, async () => {
      const t = setup(script);
      const [reply] = await ask(t.proxy.sockPath, [req(2, "tool.fill", { selector: "#pw", value: t.handle })]);
      expect(parse(reply!)).toEqual({ id: 2, error: { code: "permission_denied", message: expect.any(String), data: { reason: "secret_target_not_password", effect_state: "none" } } });
      expect(t.exchanges).toEqual([]);
      expect(t.daemon.fills).toEqual([]);
    });
  }

  test("an exchange refusal is secret_origin_not_allowed (DENIED) or secret_unavailable, detail not echoed", async () => {
    const t = setup(PASSWORD, (h) => h.endsWith("A") ? { ok: false, code: "RUNNER_SECRET_UNKNOWN", detail: "DETAIL-SECRET" } : { ok: false, code: "RUNNER_SECRET_DENIED", detail: "DETAIL-SECRET" });
    const denied = t.handle.endsWith("A") ? `${t.handle.slice(0, -1)}B` : t.handle;
    const other = `${t.handle.slice(0, -1)}A`;
    const [a, b] = await ask(t.proxy.sockPath, [req(3, "tool.fill", { selector: "#pw", value: denied }), req(4, "tool.fill", { selector: "#pw", value: other })]);
    expect(parse(a!).error?.data.reason).toBe("secret_origin_not_allowed");
    expect(parse(b!).error?.data.reason).toBe("secret_unavailable");
    expect(a + b!).not.toContain("DETAIL-SECRET");
    expect(t.daemon.fills).toEqual([]);
  });

  test("handle misuse and unsupported targets are refused before the daemon", async () => {
    const t = setup(PASSWORD);
    const escaped = JSON.stringify({ id: 9, method: "tool.type", params: { text: t.handle } }).replace("dsh_", "\\u0064sh_");
    const replies = await ask(t.proxy.sockPath, [
      req(5, "tool.type", { selector: "#pw", text: t.handle }),
      req(6, "tool.fill", { selector: t.handle, value: t.handle }),
      req(7, "tool.fill", { selector: "#pw", value: `x${t.handle}` }),
      escaped,
      req(8, "tool.fill", { ref: "e12", value: t.handle }),
      req(10, "tool.fill", { selector: "#pw", tab_id: "t1", value: t.handle }),
    ]);
    expect(replies.map((r) => parse(r).error?.data.reason)).toEqual(["secret_handle_misuse", "secret_handle_misuse", "secret_handle_misuse", "secret_handle_misuse", "secret_target_unsupported", "secret_target_unsupported"]);
    expect(t.daemon.methods).toEqual([]);
    expect(t.exchanges).toEqual([]);
  });

  test("evaluate is refused after a secret fill until session.stop", async () => {
    const t = setup(PASSWORD);
    const [before] = await ask(t.proxy.sockPath, [req(1, "tool.evaluate", { expression: "1" })]);
    expect(parse(before!).result).toBeDefined();
    await ask(t.proxy.sockPath, [req(2, "tool.fill", { selector: "#pw", value: t.handle })]);
    const [tainted, stopped, after] = await ask(t.proxy.sockPath, [req(3, "tool.evaluate", { expression: "1" }), req(4, "session.stop"), req(5, "tool.evaluate", { expression: "1" })]);
    expect(parse(tainted!).error?.data.reason).toBe("secret_tainted_session");
    expect(parse(stopped!).result).toEqual({ ok: true });
    expect(parse(after!).result).toBeDefined();
  });

  test("every encoding of an exchanged value is redacted from replies", async () => {
    const t = setup(PASSWORD);
    await ask(t.proxy.sockPath, [req(1, "tool.fill", { selector: "#pw", value: t.handle })]);
    const [reply] = await ask(t.proxy.sockPath, [req(2, "tool.get_html")]);
    const b = Buffer.from(t.value);
    for (const form of [t.value, b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), b.toString("hex"), encodeURIComponent(t.value)]) expect(reply).not.toContain(form);
    expect(parse(reply!).result?.html).toBe("<p>[REDACTED]</p><i>[REDACTED]" + (b.toString("base64").match(/=+$/)?.[0] ?? "") + "</i><b>[REDACTED]</b><u>[REDACTED]</u><s>[REDACTED]</s>");
  });

  test("a reply over 1 MiB arrives intact", async () => {
    const t = setup(PASSWORD);
    const [reply] = await ask(t.proxy.sockPath, [req(1, "tool.screenshot")]);
    expect((parse(reply!).result?.data as string).length).toBe(SCREENSHOT_BYTES);
    expect(parse(reply!).result?.data).toBe("A".repeat(SCREENSHOT_BYTES));
  });

  test("a missing upstream is daemon_unavailable", async () => {
    const t = setup(PASSWORD);
    t.setUpstream(undefined);
    const [a] = await ask(t.proxy.sockPath, [req(1, "tool.snapshot")]);
    t.setUpstream(join(t.root, "nothing.sock"));
    const [b] = await ask(t.proxy.sockPath, [req(2, "tool.snapshot")]);
    expect(parse(a!).error?.code).toBe("daemon_unavailable");
    expect(parse(b!).error?.code).toBe("daemon_unavailable");
  });

  test("dir 0700, socket 0600, daemon.json, and stop removes the dir", async () => {
    const t = setup(PASSWORD);
    expect(t.proxy.home).toBe(t.dir);
    expect(t.proxy.sockPath).toBe(join(t.dir, "daemon.sock"));
    expect(statSync(t.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(t.root, "browser")).mode & 0o777).toBe(0o700);
    expect(statSync(t.proxy.sockPath).mode & 0o777).toBe(0o600);
    const desc = join(t.dir, "daemon.json");
    expect(statSync(desc).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(desc, "utf8"))).toEqual({ pid: 4242, sock_path: t.proxy.sockPath, ws_port: 0, version: "dori-browser-proxy" });
    expect(bskDaemonSocket(t.dir)).toBe(t.proxy.sockPath);
    expect(bskDaemonSocket(join(t.root, "absent"))).toBeUndefined();
    await t.proxy.stop();
    expect(existsSync(t.dir)).toBe(false);
  });

  test("a symlinked dir is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "bfp-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "elsewhere"));
    mkdirSync(join(root, "browser"), { mode: 0o700 });
    symlinkSync(join(root, "elsewhere"), join(root, "browser", "lane-a"));
    expect(() => startBrowserProxy({ key: "lane-a", dir: join(root, "browser", "lane-a"), upstream: () => undefined, exchange: async () => ({ ok: false, code: "X", detail: "" }), log: () => {}, pid: 1 }))
      .toThrow("RUNNER_DIR_UNSAFE");
  });

  test("log lines are one per request, well formed, and carry no value or handle", async () => {
    const t = setup(PASSWORD);
    const lines = [
      req(1, "tool.fill", { selector: "#pw", value: t.handle }),
      req(2, "tool.get_html"),
      req(3, "tool.evaluate", { expression: "1" }),
      req(4, "tool.type", { text: t.handle }),
      "not json",
      req(5, "session.stop"),
    ];
    await ask(t.proxy.sockPath, lines);
    expect(t.logs).toHaveLength(lines.length);
    for (const line of t.logs) {
      expect(line).toMatch(LOG_LINE);
      expect(line).not.toContain(t.value);
      expect(line).not.toContain(t.handle);
      expect(line).not.toContain("#pw");
    }
    expect(t.logs.map((l) => l.split(" decision=")[1])).toEqual([`allow origin=${PASSWORD.origin}`, "forward", "refuse:secret_tainted_session", "refuse:secret_handle_misuse", "refuse:bad_request", "forward"]);
  });
});
