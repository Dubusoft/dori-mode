import { expect, test } from "bun:test";
import { checkRunnerPolicies, staleRunnerLabels, upgradeRunners } from "../src/runner/upgrade.ts";
import { updateInstall } from "../src/update.ts";
import type { Ran, Runner } from "../src/run.ts";

test("when the second runner's install fails the third is still upgraded and RUNNER_UPGRADE_FAILED is logged once", async () => {
  const installed: string[] = [];
  const log: string[] = [];
  const result = await upgradeRunners({
    labels: ["worker-a", "worker-b", "worker-c"],
    install: async (label) => { installed.push(label); return label === "worker-b" ? { ok: false, detail: "RUNNER_INSTALL_UNREACHABLE ssh failed" } : { ok: true, version: "abc123" }; },
    confirm: async () => true,
    log: (line) => { log.push(line); },
  });
  expect(installed).toEqual(["worker-a", "worker-b", "worker-c"]);
  expect(result).toEqual({ upgraded: 2, failed: ["worker-b"] });
  expect(log.filter((l) => l.startsWith("RUNNER_UPGRADE_FAILED"))).toEqual(["RUNNER_UPGRADE_FAILED runner=worker-b RUNNER_INSTALL_UNREACHABLE ssh failed"]);
  expect(log).toContain("RUNNER_UPGRADED runner=worker-c version=abc123");
});

test("a runner that never says hello with a higher gen fails alone and the rollout goes on", async () => {
  const installed: string[] = [];
  const log: string[] = [];
  await upgradeRunners({
    labels: ["worker-a", "worker-b"], install: async (label) => { installed.push(label); return { ok: true }; },
    confirm: async (label) => label !== "worker-a", log: (line) => { log.push(line); },
  });
  expect(installed).toEqual(["worker-a", "worker-b"]);
  expect(log).toEqual(["RUNNER_UPGRADE_FAILED runner=worker-a no hello with a higher gen after the install", "RUNNER_UPGRADED runner=worker-b"]);
});

test("the rollout skips the local runner and workers already on the wanted version", () => {
  const rows = [{ label: "local", version: "old" }, { label: "worker-a", version: "new" }, { label: "worker-b", version: "old" }, { label: "worker-c" }];
  expect(staleRunnerLabels(rows, "local", "new")).toEqual(["worker-b", "worker-c"]);
  expect(staleRunnerLabels(rows, "local", undefined)).toEqual(["worker-a", "worker-b", "worker-c"]);
});

test("the policy pass checks every runner, reports a missing config and goes on after a failed check", async () => {
  const checked: string[] = [];
  const log: string[] = [];
  const codes: Record<string, number> = { local: 0, "worker-a": 2, "worker-c": 0 };
  const result = await checkRunnerPolicies({
    labels: ["local", "worker-a", "worker-b", "worker-c"],
    check: async (label) => { checked.push(label); if (label === "worker-b") throw new Error("RUNNER_SETUP_REMOTE_FAILED worker-b: ssh\nrefused"); return codes[label]!; },
    log: (line) => { log.push(line); },
  });
  expect(checked).toEqual(["local", "worker-a", "worker-b", "worker-c"]);
  expect(result).toEqual({ missing: ["worker-a"], failed: ["worker-b"] });
  expect(log).toEqual([
    "RUNNER_POLICY_MISSING runner=worker-a; run: dori runner setup --machine worker-a",
    "RUNNER_POLICY_CHECK_FAILED runner=worker-b RUNNER_SETUP_REMOTE_FAILED worker-b: ssh refused",
    "RUNNER_POLICY_CHECKED runners=4 missing=worker-a failed=worker-b",
  ]);
});

test("an up-to-date dori update still runs the runner rollout, without restarting the supervisor", async () => {
  const order: string[] = [];
  const run: Runner = async (argv) => {
    const a = argv.join(" ");
    if (a.startsWith("git rev-parse --show-toplevel")) return { code: 0, out: "/repo", err: "" };
    if (a === "git rev-parse HEAD") return { code: 0, out: "same", err: "" };
    if (a === "git branch --show-current") return { code: 0, out: "dev", err: "" };
    if (argv[0] === "systemctl") order.push(a);
    return { code: 0, out: "", err: "" };
  };
  const log: string[] = [];
  const code = await updateInstall(
    { run, sleep: async () => {}, log: (l) => { log.push(l); }, upgradeRunners: async () => { order.push("runners"); return 0; } },
    { packageDir: "/repo/skills/dori-mode/scripts", branch: "dev", force: false },
  );
  expect(code).toBe(0);
  expect(log).toEqual(["UP_TO_DATE dev same", "UPDATE_SUMMARY changed: none; failed: none"]);
  expect(order).toEqual(["runners"]);
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
