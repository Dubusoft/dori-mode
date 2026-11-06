import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { installedLaneSandbox, LANE_SANDBOX_TEMPLATE, refreshLaneSandbox } from "../src/lane-sandbox-install.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempDir = (): string => {
  const d = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "dori-sandbox-"));
  dirs.push(d);
  return d;
};

/** Runs the shipped template with a recording `bwrap` first on PATH and returns the argv it would have run bwrap with. */
const sandboxArgv = async (home: string, env: Record<string, string>): Promise<string[]> => {
  const bin = join(home, "fake-bin");
  const out = join(home, "bwrap-argv");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "bwrap"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`);
  chmodSync(join(bin, "bwrap"), 0o755);
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  const child = Bun.spawn(["bash", LANE_SANDBOX_TEMPLATE, "true"], { cwd: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, ...env }, stdout: "pipe", stderr: "pipe" });
  expect({ code: await child.exited, err: await new Response(child.stderr).text() }).toEqual({ code: 0, err: "" });
  return readFileSync(out, "utf8").split("\n");
};

test("a sandboxed lane gets its own token file, the runner socket and its brief, and nothing else of the runner dir or the env file", async () => {
  const home = join(tempDir(), "home");
  const runner = join(home, ".dori", "runner");
  mkdirSync(join(runner, "briefs"), { recursive: true });
  mkdirSync(join(runner, "sock"), { recursive: true });
  const own = join(runner, "briefs", "lane-a.2.token");
  for (const f of [own, join(runner, "briefs", "lane-b.1.token"), join(runner, "briefs", "lane-a.md"), join(runner, "briefs", "lane-b.md"), join(home, ".dori", "env")]) writeFileSync(f, "x");

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", DORI_LANE_TOKEN_FILE: own });

  const tokenBind = argv.findIndex((a, i) => a === "--ro-bind-try" && argv[i + 1] === own && argv[i + 2] === own);
  const doriRo = argv.findIndex((a, i) => a === "--remount-ro" && argv[i + 1] === join(home, ".dori"));
  expect(tokenBind).toBeGreaterThan(-1);
  // The token's mount point has to exist before ~/.dori's tmpfs turns read-only.
  expect(tokenBind).toBeLessThan(doriRo);
  expect(argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === join(home, ".dori"))).toBeGreaterThan(-1);
  const runnerPaths = [...new Set(argv.filter((a) => a.startsWith(runner)))].sort();
  expect(runnerPaths).toEqual([join(runner, "briefs", "lane-a.2.token"), join(runner, "briefs", "lane-a.md"), join(runner, "sock")]);
  expect(argv.some((a) => a.startsWith(join(home, ".dori", "env")))).toBe(false);
});

test("every read-write mount under ~/.dori has its mount point created before ~/.dori turns read-only", async () => {
  const home = join(tempDir(), "home");
  const dori = join(home, ".dori");
  mkdirSync(join(dori, "state"), { recursive: true });

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" });

  const doriRo = argv.findIndex((a, i) => a === "--remount-ro" && argv[i + 1] === dori);
  expect(doriRo).toBeGreaterThan(-1);
  const rwInDori = argv.flatMap((a, i) => ((a === "--bind" || a === "--bind-try") && argv[i + 2]?.startsWith(`${dori}/`) ? [argv[i + 2]] : []));
  expect(rwInDori).toContain(join(dori, "heavy"));
  // bwrap cannot mkdir a missing mount point on the read-only tmpfs (EROFS), so each one is a --dir before the remount.
  const createdBefore = argv.slice(0, doriRo).flatMap((a, i, before) => (a === "--dir" ? [before[i + 1]] : []));
  expect(rwInDori.filter((p) => !createdBefore.includes(p))).toEqual([]);
});

test("refreshLaneSandbox replaces an outdated install, keeps the old copy, and leaves a current or missing one alone", () => {
  const home = tempDir();
  const installed = installedLaneSandbox(home);
  expect(refreshLaneSandbox(home)).toBeUndefined();
  expect(existsSync(installed)).toBe(false);

  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(installed, "#!/bin/sh\nold sandbox\n");
  expect(refreshLaneSandbox(home)).toStartWith(`LANE_SANDBOX_UPDATED ${installed}`);
  expect(readFileSync(installed)).toEqual(readFileSync(LANE_SANDBOX_TEMPLATE));
  expect(statSync(installed).mode & 0o777).toBe(0o755);
  expect(readFileSync(`${installed}.bak`, "utf8")).toBe("#!/bin/sh\nold sandbox\n");

  expect(refreshLaneSandbox(home)).toBeUndefined();
});
