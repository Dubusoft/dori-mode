import { expect, test } from "bun:test";
import { upgradeRunners } from "../src/runner/upgrade.ts";
import { updateInstall } from "../src/update.ts";
import type { Ran, Runner } from "../src/run.ts";

test("when the second runner's install fails the third is not tried and RUNNER_UPGRADE_FAILED is logged once", async () => {
  const installed: string[] = [];
  const log: string[] = [];
  const result = await upgradeRunners({
    labels: ["worker-a", "worker-b", "worker-c"],
    install: async (label) => { installed.push(label); return label === "worker-b" ? { ok: false, detail: "RUNNER_INSTALL_UNREACHABLE ssh failed" } : { ok: true, version: "abc123" }; },
    confirm: async () => true,
    log: (line) => { log.push(line); },
  });
  expect(installed).toEqual(["worker-a", "worker-b"]);
  expect(result).toEqual({ upgraded: 1, failed: "worker-b" });
  expect(log.filter((l) => l.startsWith("RUNNER_UPGRADE_FAILED"))).toEqual(["RUNNER_UPGRADE_FAILED runner=worker-b RUNNER_INSTALL_UNREACHABLE ssh failed; the remaining runners were not upgraded"]);
});

test("a runner that never says hello with a higher gen stops the rollout too", async () => {
  const installed: string[] = [];
  const log: string[] = [];
  await upgradeRunners({
    labels: ["worker-a", "worker-b"], install: async (label) => { installed.push(label); return { ok: true }; },
    confirm: async (label) => label !== "worker-a", log: (line) => { log.push(line); },
  });
  expect(installed).toEqual(["worker-a"]);
  expect(log).toEqual(["RUNNER_UPGRADE_FAILED runner=worker-a no hello with a higher gen after the install; the remaining runners were not upgraded"]);
});

test("dori update restarts the supervisor before it upgrades any runner", async () => {
  const order: string[] = [];
  const git = (args: readonly string[]): Ran => {
    const a = args.join(" ");
    if (a.startsWith("rev-parse --show-toplevel")) return { code: 0, out: "/repo", err: "" };
    if (a === "rev-parse HEAD") return { code: 0, out: order.includes("merge") ? "new" : "old", err: "" };
    if (a === "branch --show-current") return { code: 0, out: "dev", err: "" };
    return { code: 0, out: "", err: "" };
  };
  const run: Runner = async (argv) => {
    if (argv[0] === "git") { if (argv[1] === "merge") order.push("merge"); return git(argv.slice(1)); }
    if (argv.join(" ") === "systemctl --user restart dori-supervisor.service") { order.push("supervisor-restart"); return { code: 0, out: "", err: "" }; }
    if (argv.join(" ") === "systemctl --user is-active dori-supervisor.service") return { code: 0, out: "active", err: "" };
    return { code: 0, out: "", err: "" };
  };
  const code = await updateInstall(
    { run, sleep: async () => {}, log: () => {}, upgradeRunners: async () => { order.push("runners"); return 0; } },
    { packageDir: "/repo/skills/dori-mode/scripts", branch: "dev", force: false },
  );
  expect(code).toBe(0);
  expect(order).toEqual(["merge", "supervisor-restart", "runners"]);
});
