import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

test("dori sync prints a summary by default and the table with --full", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "cli-sync-"));
  const preload = join(dir, "sync-preload.ts");
  const runModule = JSON.stringify(join(import.meta.dir, "..", "src", "run.ts"));
  writeFileSync(preload, `
    import { mock } from "bun:test";
    mock.module(${runModule}, () => ({
      DEFAULT_RUN_TIMEOUT_MS: 60_000,
      RUN_KILL_GRACE_MS: 1_500,
      RUN_TIMEOUT_CODE: 124,
      realClock: { now: () => Date.now(), sleep: async () => {} },
      run: async (argv: string[]) => ({
        code: 0,
        out: argv[0] === "herdr" ? JSON.stringify({ result: { panes: [] } }) : "",
        err: "",
      }),
      defaultRunTimeout: () => 60_000,
      iso: (clock: { now: () => number }) => new Date(clock.now()).toISOString(),
      setDefaultRunTimeout: () => {},
    }));
  `);
  try {
    const summaryProc = spawnCli(dir, ["sync"], preload);
    const [summary, summaryErr, summaryCode] = await Promise.all([
      new Response(summaryProc.stdout).text(), new Response(summaryProc.stderr).text(), summaryProc.exited,
    ]);
    expect(summaryCode, summaryErr).toBe(0);
    expect(summary).toContain("LANES 0; UNREGISTERED 0; --full for the table");
    expect(summary).not.toContain("key | thread | pane | session | status");

    const fullProc = spawnCli(dir, ["sync", "--full"], preload);
    const [full, fullErr, fullCode] = await Promise.all([
      new Response(fullProc.stdout).text(), new Response(fullProc.stderr).text(), fullProc.exited,
    ]);
    expect(fullCode, fullErr).toBe(0);
    expect(full).toContain("key | thread | pane | session | status");
  } finally {
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
      REMOTE_SEEN_MAX: 100,
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
