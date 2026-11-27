import type { Pane } from "../panes.ts";
import type { Runner } from "../run.ts";
import type { ProcessInfo } from "../runner/protocol.ts";
import { herdrProcess } from "../runner/herdr-watch.ts";
import { inspectCreated } from "../runner/lane-control.ts";
import type { OpenSpec, OpenedSession, SessionRuntime } from "./types.ts";

/** herdr behind the session runtime interface: the herdr CLI calls the runner has always made, unchanged. */
export const herdrRuntime = (run: Runner): SessionRuntime => ({
  kind: "herdr",
  instance: async () => (await herdrProcess(run)).instance,
  listPanes: async () => {
    const r = await run(["herdr", "pane", "list"]);
    if (r.code !== 0) throw new Error(`herdr pane list failed: ${r.err || r.out}`);
    return (JSON.parse(r.out) as { result: { panes: Pane[] } }).result.panes;
  },
  read: async (pane, lines) =>
    (await run(["herdr", "pane", "read", pane, "--source", lines ? "recent" : "visible", ...(lines ? ["--lines", String(lines)] : [])])).out,
  sendText: async (pane, text) => {
    if ((await run(["herdr", "pane", "send-text", pane, text])).code !== 0) return false;
    await run(["herdr", "pane", "send-keys", pane, "enter"]);
    return true;
  },
  key: async (pane, key) => (await run(["herdr", "pane", "send-keys", pane, key])).code === 0,
  processInfo: async (pane) => {
    const r = await run(["herdr", "pane", "process-info", "--pane", pane]);
    if (r.code !== 0) return { error: (r.err || r.out).trim() || `herdr exited ${r.code}` };
    try {
      const info = (JSON.parse(r.out) as { result?: { process_info?: ProcessInfo } }).result?.process_info;
      return info ? { info } : { error: "herdr process-info: no process_info in the answer" };
    } catch {
      return { error: "herdr process-info: unreadable answer" };
    }
  },
  open: async (spec: OpenSpec): Promise<OpenedSession> => {
    const workspace = spec.workspace ? ["--workspace", spec.workspace] : [];
    const created = await run(["herdr", "tab", "create", ...workspace, "--cwd", spec.cwd, "--label", spec.key, "--no-focus"]);
    if (created.code !== 0) throw new Error(`herdr tab create failed: ${(created.err || created.out).trim()}`);
    const made = (JSON.parse(created.out) as { result: { root_pane: { pane_id: string; tab_id?: string }; tab_id?: string } }).result;
    const pane = made.root_pane.pane_id;
    const inspected = await inspectCreated(run, pane);
    return { pane, tab: made.tab_id ?? made.root_pane.tab_id ?? "", ...inspected };
  },
  run: (pane, command) => run(["herdr", "pane", "run", pane, command]),
  close: async (pane, tab) => {
    if (tab) await run(["herdr", "tab", "close", tab]);
    else await run(["herdr", "pane", "close", pane]);
  },
});
