import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { defaultRunnerDir } from "../src/runner/fs-safety.ts";
import { cliSocketPath } from "../src/runner/cli-relay.ts";

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

const spawnCli = (dir: string, args: string[], preload?: string) => Bun.spawn([
  "bun", ...(preload ? ["--preload", preload] : []), cliPath, ...args,
], {
  env: {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    TMPDIR: process.env.TMPDIR ?? dir,
    DORI_CONFIG: join(dir, "no-config.json"),
    DORI_STATE_DIR: dir,
  },
  stdout: "pipe",
  stderr: "pipe",
});

test("dori sync prints a summary by default and the table with --full, reading panes through the supervisor's CLI relay", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "cli-sync-"));
  const sock = cliSocketPath(defaultRunnerDir(dir));
  mkdirSync(dirname(sock), { recursive: true });
  const queries: string[] = [];
  let pending = "";
  const server = Bun.listen({
    unix: sock,
    socket: {
      data(socket, data) {
        pending += data.toString();
        for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
          const request = JSON.parse(pending.slice(0, nl)) as { id: string; op: string; type?: string };
          pending = pending.slice(nl + 1);
          queries.push(request.type ?? request.op);
          socket.write(`${JSON.stringify({ id: request.id, ok: true, value: { panes: [] } })}\n`);
        }
      },
    },
  });
  try {
    const summaryProc = spawnCli(dir, ["sync"]);
    const [summary, summaryErr, summaryCode] = await Promise.all([
      new Response(summaryProc.stdout).text(), new Response(summaryProc.stderr).text(), summaryProc.exited,
    ]);
    expect(summaryCode, summaryErr).toBe(0);
    expect(summary).toContain("LANES 0; UNREGISTERED 0; --full for the table");
    expect(summary).not.toContain("key | thread | pane | session | status");
    // First the supervisor check every lane command makes (RUNNER_UNAVAILABLE exit 2 when it is down), then one pane list.
    expect(queries).toEqual(["connected", "q.panes"]);

    const fullProc = spawnCli(dir, ["sync", "--full"]);
    const [full, fullErr, fullCode] = await Promise.all([
      new Response(fullProc.stdout).text(), new Response(fullProc.stderr).text(), fullProc.exited,
    ]);
    expect(fullCode, fullErr).toBe(0);
    expect(full).toContain("key | thread | pane | session | status");
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dori watch suppresses repeated warnings per lane and reason until they clear", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "cli-watch-"));
  const preload = join(dir, "watch-preload.ts");
  const doneFlow = JSON.stringify(join(import.meta.dir, "..", "src", "done-flow.ts"));
  writeFileSync(preload, `
    import { mock } from "bun:test";
    let tick = 0;
    let sleep = 0;
    const results = [
      ["LANE_WATCH_WARN alpha worktree locked"],
      ["LANE_WATCH_WARN alpha worktree locked", "LANE_WATCH_WARN beta registry unreadable"],
      [],
      ["LANE_WATCH_WARN alpha worktree locked"],
    ];
    mock.module(${doneFlow}, () => ({
      callerLane: async () => undefined,
      claimDone: async () => "",
      closeLane: async () => ({}),
      finishedReason: () => "",
      laneActRefusal: () => undefined,
      laneSendRefusal: () => undefined,
      laneMeta: () => ({}),
      objectDone: async () => "",
      watchTick: async () => results[tick++] ?? [],
    }));
    Bun.sleep = async () => { if (++sleep === 4) process.exit(0); };
  `);
  try {
    const child = spawnCli(dir, ["watch"], preload);
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code, err).toBe(0);
    expect(out.match(/LANE_WATCH_WARN alpha worktree locked/g)).toHaveLength(2);
    expect(out.match(/LANE_WATCH_WARN beta registry unreadable/g)).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
