import { join } from "node:path";
import { parseArgs } from "node:util";

import type { Json, KeyPrompter } from "./config-keys.ts";
import { loadConfig } from "./config.ts";
import { laneOps } from "./lane-ops.ts";
import { Registry, statusOf } from "./registry.ts";
import { type GuardMachine, listGuardMachines, machineKind, type MachineKind } from "./remote-guard.ts";
import { realClock, run, setDefaultRunTimeout } from "./run.ts";
import { cliRunnerCall, cliSocketPath } from "./runner/cli-relay.ts";
import { defaultRunnerDir } from "./runner/fs-safety.ts";
import { LOCAL_RUNNER } from "./runner/serve.ts";
import { remoteRunnerCli, remoteRunnerService } from "./runner/service.ts";

let ttyKeyPrompter: KeyPrompter | undefined;

/**
 * `dori runner setup` against the local runner (no machine) or a saved machine over ssh; the keys shown are recorded in
 * <stateDir>/runner-setup-keys/<label|local>.json. Returns runRunnerSetup's code; an unknown machine kind or a remote IO
 * failure throws.
 */
const runnerSetupNow = async (
  stateDir: string, machine: GuardMachine | undefined,
  o: { readonly patch: Json; readonly unset: readonly string[]; readonly interactive: boolean; readonly mode: "full" | "new"; readonly requireFile?: boolean },
): Promise<number> => {
  const { localRunnerConfigIO, remoteRunnerConfigIO, runRunnerSetup } = await import("./runner/runner-setup.ts");
  const { defaultsPrompter, ttyPrompter } = await import("./setup-cli.ts");
  let io = localRunnerConfigIO(defaultRunnerDir());
  if (machine !== undefined) {
    const kind = await machineKind(run, machine);
    if (!kind.ok) throw new Error(`RUNNER_SETUP_FAILED ${machine.label}: ${kind.detail}`);
    io = remoteRunnerConfigIO(run, machine, kind.kind);
  }
  return runRunnerSetup({
    io, prompt: o.interactive ? (ttyKeyPrompter ??= ttyPrompter()) : defaultsPrompter, interactive: o.interactive,
    log: (line) => { console.log(line); }, seenPath: join(stateDir, "runner-setup-keys", `${machine?.label ?? "local"}.json`), mode: o.mode,
    requireFile: o.requireFile,
  }, { patch: o.patch, unset: o.unset });
};

/**
 * `dori update`'s worker migration: first the old standalone guard agent files are removed from every machine (their
 * failures are logged and never change the exit code), then each worker runner gets the new bundle through
 * `dori runner install`'s path, one at a time, each confirmed by a hello with a higher gen within 2 minutes. The local
 * runner is the supervisor's child, so the supervisor restart that `dori update` already did restarted it on the
 * updated checkout. A runner that already reports this checkout's version is skipped. Then every runner, upgraded or
 * not (the local one and each worker the hub knows), gets runner setup in "new" mode (asks only keys never shown
 * before): a worker without runner-config.json, a missing required key or a failed check is reported.
 * Returns 1 when any runner failed to upgrade or its policy check found a gap (the others still ran), else 0.
 */
const upgradeRunnersNow = async (cfg: Awaited<ReturnType<typeof loadConfig>>): Promise<number> => {
  const { readRunnerRows } = await import("./runner/hub.ts");
  const { checkRunnerPolicies, staleRunnerLabels, upgradeRunners } = await import("./runner/upgrade.ts");
  const { gitVersion } = await import("./runner/version.ts");
  const { buildBundle, installRunner } = await import("./runner/install.ts");
  const { runnerListenAddress } = await import("./runner/endpoints.ts");
  const { SupervisorAuth } = await import("./runner/auth.ts");
  const rows = readRunnerRows(cfg.stateDir);
  const genOf = (label: string): number => readRunnerRows(cfg.stateDir).find((r) => r.label === label)?.maxGen ?? 0;
  const machines = listGuardMachines(cfg.guardMachines, cfg.stateDir);
  let bundle: string | undefined;
  const auth = new SupervisorAuth(cfg.stateDir, { now: realClock.now });
  const before = new Map(rows.map((r) => [r.label, r.maxGen]));
  try {
    const result = await upgradeRunners({
      labels: staleRunnerLabels(rows, LOCAL_RUNNER, await gitVersion(run, import.meta.dir)),
      install: async (label) => {
        const machine = machines.find((m) => m.label === label);
        if (!machine) return { ok: false, detail: `no machine ${label}` };
        bundle ??= await buildBundle(run, undefined, cfg.stateDir)();
        const done = await installRunner({ run, bundle: async () => bundle as string }, {
          machine, label, listenAddress: await runnerListenAddress(machine.target), stateDir: cfg.stateDir,
          agentCommand: cfg.agentCommand,
          issue: () => ({ code: auth.issueCode(label).code, fingerprint: auth.fingerprint }),
          enroll: (body) => auth.enroll(body),
        });
        if (!done.ok) return { ok: false, detail: `${done.code} ${done.detail}` };
        return { ok: true, version: done.version };
      },
      confirm: async (label) => {
        for (const until = realClock.now() + 120_000; realClock.now() < until; await realClock.sleep(2_000)) {
          if (genOf(label) > (before.get(label) ?? 0)) return true;
        }
        return false;
      },
      log: (line) => console.log(line),
    });
    const policy = await checkRunnerPolicies({
      labels: [LOCAL_RUNNER, ...new Set(readRunnerRows(cfg.stateDir).map((r) => r.label).filter((l) => l !== LOCAL_RUNNER))],
      check: async (label) => {
        const local = label === LOCAL_RUNNER;
        const machine = local ? undefined : machines.find((m) => m.label === label);
        if (!local && !machine) throw new Error(`no machine ${label}`);
        return runnerSetupNow(cfg.stateDir, machine, { patch: {}, unset: [], interactive: Boolean(process.stdin.isTTY), mode: "new", requireFile: !local });
      },
      log: (line) => console.log(line),
    });
    return result.failed.length || policy.missing.length || policy.failed.length ? 1 : 0;
  } finally {
    auth.close();
  }
};

export type RunnerAdminDeps = { readonly die: (message: string, code?: number) => never };

/**
 * `dori runner <sub>` on the supervisor host (every sub-command but serve and probe), read from process.argv. Each
 * sub-command ends the process itself (process.exit, or die on a bad argument).
 */
export const runnerAdminMain = async ({ die }: RunnerAdminDeps): Promise<number> => {
  // enroll, install, revoke, rotate, reset-gen and upgrade run on the supervisor host against <stateDir>.
  const usage = "usage: dori runner serve [--label LABEL] [--enroll | --enroll-only] [--listen HOST:PORT] | probe [--json] | enroll --machine LABEL | install (TARGET [--label LABEL] | --machine LABEL) [--set KEY=VALUE ...] [--unset KEY ...] [--yes] | setup [--machine LABEL] [--set KEY=VALUE ...] [--unset KEY ...] [--yes] [--new] | remove LABEL | revoke LABEL | rotate LABEL | reset-gen LABEL | upgrade";
  const parsed = parseArgs({
    args: process.argv.slice(3), allowPositionals: true,
    options: {
      machine: { type: "string" }, label: { type: "string" }, yes: { type: "boolean" },
      set: { type: "string", multiple: true }, unset: { type: "string", multiple: true }, new: { type: "boolean" },
    },
  });
  const [sub = "", target, ...extra] = parsed.positionals;
  if (extra.length) die(usage);
  const { LABEL_PATTERN } = await import("./runner/protocol.ts");
  const labelArg = (value: string | undefined): string => {
    if (!value || !LABEL_PATTERN.test(value)) die(usage);
    return value as string;
  };
  if (parsed.values.yes && sub !== "setup" && sub !== "install") die(usage);
  if (parsed.values.label !== undefined && sub !== "install") die(usage);
  if ((parsed.values.set !== undefined || parsed.values.unset !== undefined) && sub !== "setup" && sub !== "install") die(usage);
  if (parsed.values.new && sub !== "setup") die(usage);
  /** --set/--unset against runner-config.json's keys; an unknown key or bad value stops before anything runs. */
  const runnerKeys = async (): Promise<{ patch: Json; unset: readonly string[] }> => {
    const { ConfigKeyError, parseSetArgs, RUNNER_CONFIG_KEYS } = await import("./config-keys.ts");
    try {
      return parseSetArgs(RUNNER_CONFIG_KEYS, parsed.values.set ?? [], parsed.values.unset ?? []);
    } catch (e) {
      if (!(e instanceof ConfigKeyError)) throw e;
      return die(`RUNNER_SETUP_FAILED ${e.message}`);
    }
  };
  const setupInteractive = !parsed.values.yes && Boolean(process.stdin.isTTY);
  if (sub === "setup") {
    if (target !== undefined) die(usage);
    const keys = await runnerKeys();
    const cfg = await loadConfig();
    setDefaultRunTimeout(cfg.runTimeoutMs);
    let machine: GuardMachine | undefined;
    if (parsed.values.machine !== undefined) {
      const label = labelArg(parsed.values.machine);
      machine = listGuardMachines(cfg.guardMachines, cfg.stateDir).find((m) => m.label === label) ?? die(`RUNNER_UNKNOWN_MACHINE ${label}`);
    }
    let code: number;
    try {
      code = await runnerSetupNow(cfg.stateDir, machine, { ...keys, interactive: setupInteractive, mode: parsed.values.new ? "new" : "full" });
    } catch (e) {
      code = die(e instanceof Error ? e.message : String(e));
    }
    process.exit(code);
  }
  if (sub === "upgrade") {
    if (target !== undefined || parsed.values.machine !== undefined) die(usage);
    const cfg = await loadConfig();
    setDefaultRunTimeout(cfg.runTimeoutMs);
    process.exit(await upgradeRunnersNow(cfg));
  }
  if (sub === "enroll") {
    // The code and fingerprint go to stdout only: the installer pipes them into the runner's stdin over ssh.
    const label = labelArg(parsed.values.machine);
    if (target !== undefined) die(usage);
    const cfg = await loadConfig();
    const { SupervisorAuth } = await import("./runner/auth.ts");
    const auth = new SupervisorAuth(cfg.stateDir, { now: realClock.now });
    try {
      const issued = auth.issueCode(label);
      process.stdout.write(`code=${issued.code}\nfingerprint=${auth.fingerprint}\n`);
      process.stderr.write(`RUNNER_ENROLL_CODE runner=${label} expiresAt=${new Date(issued.expiresAt).toISOString()}\n`);
    } finally {
      auth.close();
    }
    process.exit(0);
  }
  if (sub === "install") {
    // Exactly one of a positional ssh target (user@ip, ip, user@host) or --machine LABEL.
    if ((target === undefined) === (parsed.values.machine === undefined)) die(usage);
    if (parsed.values.machine !== undefined && parsed.values.label !== undefined) die(usage);
    const { labelFromHost, parseInstallTarget, writeRunnerMachine } = await import("./runner/machines.ts");
    let direct: { label: string; target: string } | undefined;
    if (target !== undefined) {
      try {
        const parsedTarget = parseInstallTarget(target);
        direct = { label: parsed.values.label === undefined ? labelFromHost(parsedTarget.host) : labelArg(parsed.values.label), target: parsedTarget.target };
      } catch (e) {
        die(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
      }
    }
    const label = direct?.label ?? labelArg(parsed.values.machine);
    const keys = await runnerKeys();
    const cfg = await loadConfig();
    setDefaultRunTimeout(cfg.runTimeoutMs);
    const machine = direct ?? listGuardMachines(cfg.guardMachines, cfg.stateDir).find((m) => m.label === label) ?? die(`RUNNER_UNKNOWN_MACHINE ${label}`);
    const { SupervisorAuth } = await import("./runner/auth.ts");
    const { buildBundle, hcInstallNote, installRunner } = await import("./runner/install.ts");
    const { runnerListenAddress } = await import("./runner/endpoints.ts");
    const auth = new SupervisorAuth(cfg.stateDir, { now: realClock.now });
    try {
      // The code is issued in this process and handed to the installer as data; it never enters an argv.
      const result = await installRunner({ run, bundle: buildBundle(run), progress: (line) => { console.log(line); } }, {
        machine, label, listenAddress: await runnerListenAddress(machine.target), stateDir: cfg.stateDir,
        agentCommand: cfg.agentCommand,
        issue: () => ({ code: auth.issueCode(label).code, fingerprint: auth.fingerprint }),
        enroll: (body) => auth.enroll(body),
      });
      if (!result.ok) die(`${result.code} runner=${label} ${result.detail}`);
      if (direct) writeRunnerMachine(cfg.stateDir, direct.label, direct.target);
      console.log(`RUNNER_INSTALLED runner=${label} version=${result.ok ? result.version : ""} ${hcInstallNote(result.ok ? result.hc : undefined)}`);
    } finally {
      auth.close();
    }
    const setup = await runnerSetupNow(cfg.stateDir, machine, { ...keys, interactive: setupInteractive, mode: "new" })
      .catch((e: unknown) => { console.log(e instanceof Error ? e.message : String(e)); return 1; });
    if (setup !== 0) {
      console.log(`RUNNER_SETUP_AFTER_INSTALL_FAILED runner=${label} run: dori runner setup --machine ${label}`);
      process.exit(setup);
    }
    process.exit(0);
  }
  if (sub === "remove") {
    if (parsed.values.machine !== undefined) die(usage);
    const label = labelArg(target);
    const cfg = await loadConfig();
    setDefaultRunTimeout(cfg.runTimeoutMs);
    const { hasLocalRunnerState, planRemove, removeRunner } = await import("./runner/remove.ts");
    // A label dropped from config and runner-machines state but still known locally (keys, hub row, endpoint) is cleaned up here only.
    const plan = planRemove(listGuardMachines(cfg.guardMachines, cfg.stateDir), label, hasLocalRunnerState(cfg.stateDir, label));
    if (plan.kind === "unknown") die(`RUNNER_UNKNOWN_MACHINE ${label}`);
    const { runnerOf } = await import("./lane-ops.ts");
    const busy = (await new Registry(cfg.stateDir).open()).filter((lane) => statusOf(lane) !== "closed" && runnerOf(lane) === label);
    if (busy.length) die(`RUNNER_REMOVE_BUSY runner=${label} open lanes: ${busy.map((lane) => lane.key).join(",")}; close them or run dori runner evacuate ${label} first`);
    const { stepper } = await import("./runner/steps.ts");
    const step = stepper((line) => { console.log(line); }, label);
    if (plan.kind === "remote") {
      const result = await removeRunner({ run, progress: (line) => { console.log(line); } }, { machine: plan.machine, label });
      if (!result.ok) die(`${result.code} runner=${label} ${result.detail}`);
    } else {
      step("uninstall", "skipped", "no saved machine; the worker is not touched");
    }
    step("cleanup", "start", "key, supervisor link, endpoint, machine, hub row");
    // Only after the worker is clean: the key, a live supervisor's link, the endpoint and the remembered machine go.
    const { SupervisorAuth } = await import("./runner/auth.ts");
    const { queueRunnerAdmin } = await import("./runner/serve.ts");
    const { removeRunnerEndpoint } = await import("./runner/endpoints.ts");
    const { removeRunnerMachine } = await import("./runner/machines.ts");
    const auth = new SupervisorAuth(cfg.stateDir, { now: realClock.now });
    try {
      auth.revoke(label);
    } finally {
      auth.close();
    }
    queueRunnerAdmin(cfg.stateDir, "revoke", label, realClock.now());
    removeRunnerEndpoint(cfg.stateDir, label);
    removeRunnerMachine(cfg.stateDir, label);
    const { forgetRunner } = await import("./runner/hub.ts");
    forgetRunner(cfg.stateDir, label);
    step("cleanup", "done");
    console.log(`RUNNER_REMOVED runner=${label}${plan.kind === "local" ? " local-only (no saved machine; the worker was not touched)" : ""}`);
    process.exit(0);
  }
  if (sub === "evacuate") {
    const label = labelArg(target);
    const cfg = await loadConfig();
    setDefaultRunTimeout(cfg.runTimeoutMs);
    const { sshArgv } = await import("./remote-guard.ts");
    const { openLaneReports } = await import("./lane-report-store.ts");
    const { evacuate } = await import("./runner/evacuate.ts");
    const machine = listGuardMachines(cfg.guardMachines, cfg.stateDir).find((m) => m.label === label);
    if (!machine) die(`RUNNER_UNKNOWN_MACHINE ${label}`);
    const sshTarget = (machine as NonNullable<typeof machine>).target;
    // The worker's commands take the form of its kind (POSIX sh or Windows PowerShell); found once, on first use.
    let kind: Promise<MachineKind> | undefined;
    const kindOf = (): Promise<MachineKind> => (kind ??= machineKind(run, machine as NonNullable<typeof machine>).then((k) => {
      if (!k.ok) throw new Error(`machine kind: ${k.detail}`);
      return k.kind;
    }));
    const store = openLaneReports(cfg);
    // The notice goes through the runner being evacuated (D9), so it is sent before the runner is stopped.
    const ops = laneOps(cliRunnerCall(cliSocketPath(defaultRunnerDir())), { now: realClock.now, log: (line) => { console.error(line); } });
    try {
      const lines = await evacuate({
        hub: {
          stateDir: cfg.stateDir, registry: new Registry(cfg.stateDir), reports: () => store,
          now: realClock.now, emit: (_id, line) => { console.log(line); },
          // Evacuation imports events without dispatching inventory recovery. Like the supervisor's
          // absent-inventory path, preparation carries no attachments.
          prepareRecovery: async (_label, key) => ({ cmdId: `recover:${key}:${realClock.now()}`, notes: [] }),
          recover: () => undefined,
        },
        exportOutbox: async () => {
          const r = await run(sshArgv(sshTarget, remoteRunnerCli("runner export-outbox", await kindOf())), { timeoutMs: 30_000 });
          if (r.code !== 0) throw new Error(`export-outbox exit ${r.code}: ${(r.err || r.out).trim().split("\n").at(-1) ?? ""}`);
          return JSON.parse(r.out.trim().split("\n").at(-1) ?? "[]");
        },
        tellLane: async (lane, text) => (await ops.send(lane, text)) !== "failed",
        stopRunner: async () => {
          const r = await run(sshArgv(sshTarget, remoteRunnerService("stop", await kindOf())), { timeoutMs: 30_000 });
          return { ok: r.code === 0, detail: (r.err || r.out).trim().split("\n").at(-1) || `exit ${r.code}` };
        },
      }, label);
      for (const line of lines) console.log(line);
    } finally {
      store.close();
    }
    process.exit(0);
  }
  if (sub === "revoke" || sub === "rotate" || sub === "reset-gen") {
    const label = labelArg(target);
    const cfg = await loadConfig();
    if (sub === "reset-gen") {
      const { resetRunnerGen } = await import("./runner/hub.ts");
      if (!resetRunnerGen(cfg.stateDir, label)) die(`RUNNER_UNKNOWN ${label}`);
      console.log(`RUNNER_GEN_RESET runner=${label}`);
      process.exit(0);
    }
    const { SupervisorAuth } = await import("./runner/auth.ts");
    const { queueRunnerAdmin, runnerAdminResult } = await import("./runner/serve.ts");
    // The supervisor's runners task answers queued requests every few seconds.
    const waitFor = async <T>(read: () => T | undefined, ms: number): Promise<T | undefined> => {
      for (const until = realClock.now() + ms; realClock.now() < until; await realClock.sleep(500)) {
        const value = read();
        if (value !== undefined) return value;
      }
      return read();
    };
    const auth = new SupervisorAuth(cfg.stateDir, { now: realClock.now });
    try {
      if (sub === "revoke") {
        // The key is deleted here at once, so later hellos are refused even with the supervisor down; the live link
        // closes when the supervisor takes the request.
        if (!auth.revoke(label)) die(`RUNNER_UNKNOWN ${label} is not enrolled`);
        const id = queueRunnerAdmin(cfg.stateDir, "revoke", label, realClock.now());
        const result = await waitFor(() => runnerAdminResult(cfg.stateDir, id), 15_000);
        console.log(`RUNNER_REVOKED runner=${label} link=${result ?? "pending (supervisor has not answered)"}`);
        process.exit(0);
      }
      const before = auth.key(label);
      if (!before?.pubKey) die(`RUNNER_UNKNOWN ${label} is not enrolled`);
      const id = queueRunnerAdmin(cfg.stateDir, "rotate", label, realClock.now());
      const result = await waitFor(() => runnerAdminResult(cfg.stateDir, id), 15_000);
      if (!result?.startsWith("sent ")) die(`RUNNER_ROTATE_FAILED runner=${label} ${result ?? "the supervisor did not answer"}`);
      const rotated = await waitFor(() => {
        const row = auth.key(label);
        return row?.pubKey && row.pubKey !== before?.pubKey ? row.pubKey : undefined;
      }, 15_000);
      if (!rotated) die(`RUNNER_ROTATE_PENDING runner=${label} ${result} (the runner has not answered yet)`);
      const { fingerprint } = await import("./runner/auth.ts");
      console.log(`RUNNER_KEY_ROTATED runner=${label} key=${fingerprint(rotated as string)}`);
      process.exit(0);
    } finally {
      auth.close();
    }
  }
  die(usage);
  return 1;
};
