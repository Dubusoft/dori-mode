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

test("a sandboxed lane gets its own token file, the runner socket, its brief and the runner's bin (read-only), and nothing else of the runner dir or the env file", async () => {
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
  expect(runnerPaths).toEqual([join(runner, "bin"), join(runner, "briefs", "lane-a.2.token"), join(runner, "briefs", "lane-a.md"), join(runner, "sock")]);
  // A worker host's dori lives in bin: bound read-only, never read-write, so a lane cannot rewrite what the runner runs.
  const bin = join(runner, "bin");
  expect(argv.flatMap((a, i) => (argv[i + 1] === bin && argv[i + 2] === bin ? [a] : []))).toEqual(["--ro-bind-try"]);
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

test("the top-level directory holding $HOME is the sandbox's own, not a read-only bind of the host's root-owned one", async () => {
  // Under TMPDIR (/tmp, /dev/shm) the top-level entry is skipped anyway; next to this file it is one the script binds.
  const home = mkdtempSync(join(import.meta.dir, ".sandbox-home-"));
  dirs.push(home);
  const top = `/${home.split("/")[1]}`;

  const argv = await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" });

  // A host bind shows root as the overflow uid inside the user namespace, and omo refuses that trust ancestor.
  expect(argv.filter((a, i) => a.startsWith("--") && argv[i + 1] === top)).toEqual([]);
});

test("LANE_SANDBOX_VERIFY is bound read-write on its own, leaving its parent directories unbound", async () => {
  const home = join(tempDir(), "home");
  const state = join(home, "..", "ws", "state");
  const verify = join(state, "verify");
  mkdirSync(verify, { recursive: true });

  const rw = (argv: string[]) => argv.flatMap((a, i) => (a === "--bind" || a === "--bind-try" ? [argv[i + 2] ?? ""] : []));
  const bound = rw(await sandboxArgv(home, { DORI_LANE_KEY: "lane-a", LANE_SANDBOX_VERIFY: verify }));
  expect(bound).toContain(verify);
  expect(bound).not.toContain(state);
  expect(bound).not.toContain(join(state, ".."));

  expect(rw(await sandboxArgv(home, { DORI_LANE_KEY: "lane-a" }))).not.toContain(verify);
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

/** Runs `lane-sandbox --check` with PATH limited to `bin` (plus the dirs bash needs) and DORI_LANE_KEY unset, like the lead. */
const check = async (bin: string) => {
  const child = Bun.spawn([Bun.which("bash") ?? "bash", LANE_SANDBOX_TEMPLATE, "--check"], { env: { PATH: bin, HOME: bin }, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, err: await new Response(child.stderr).text() };
};
const fakeBwrap = (dir: string, body: string): string => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "bwrap"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "bwrap"), 0o755);
  return bin;
};

test("--check exits 3 with one stderr line when bwrap is not on PATH", async () => {
  const empty = join(tempDir(), "empty");
  mkdirSync(empty);
  const r = await check(empty);
  expect(r.code).toBe(3);
  expect(r.err.trim().split("\n")).toEqual(["lane-sandbox: bwrap not found on PATH"]);
});

test("--check exits 0 when bwrap --ro-bind / / true succeeds, even without DORI_LANE_KEY", async () => {
  const dir = tempDir();
  const bin = fakeBwrap(dir, `[ "$*" = "--ro-bind / / true" ] || exit 9`);
  expect(await check(bin)).toEqual({ code: 0, err: "" });
});

test("--check exits 3 with bwrap's reason on one line when bwrap cannot create a sandbox", async () => {
  const bin = fakeBwrap(tempDir(), 'echo "bwrap: No permissions to create new namespace" >&2; exit 1');
  const r = await check(bin);
  expect(r.code).toBe(3);
  expect(r.err.trim().split("\n")).toEqual(["lane-sandbox: bwrap cannot create a sandbox: bwrap: No permissions to create new namespace"]);
});
