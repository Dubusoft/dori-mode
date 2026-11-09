import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteRunnerCli, remoteRunnerService } from "../src/runner/service.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const fakeHost = (os: "Darwin" | "Linux", managerExit = 0) => {
  const home = mkdtempSync(join(tmpdir(), "runner-service-home-"));
  dirs.push(home);
  const bin = join(home, "fakebin");
  mkdirSync(bin);
  const log = join(home, "argv.log");
  const tool = (name: string, body: string, logged = true) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${logged ? `printf '%s %s\\n' '${name}' "$*" >> '${log}'\n` : ""}${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool("uname", `echo ${os}`, false);
  tool("id", "echo 501", false);
  tool("launchctl", `exit ${managerExit}`);
  tool("systemctl", `exit ${managerExit}`);
  tool("bun", "exit 0");
  return { home, bin, log };
};

const exec = async (host: ReturnType<typeof fakeHost>, command: string) => {
  const p = Bun.spawn(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "pipe", env: { HOME: host.home, PATH: `${host.bin}:/usr/bin:/bin` } });
  const code = await p.exited;
  let calls = "";
  try { calls = readFileSync(host.log, "utf8"); } catch { calls = ""; }
  return { code, calls: calls.split("\n").filter(Boolean) };
};

const writeDomain = (host: ReturnType<typeof fakeHost>, domain: string) => {
  mkdirSync(join(host.home, ".dori/runner"), { recursive: true });
  writeFileSync(join(host.home, ".dori/runner/launchd-domain"), `${domain}\n`);
};

test("on Linux, restart and stop run exactly the systemctl user command", async () => {
  for (const action of ["restart", "stop"] as const) {
    const host = fakeHost("Linux");
    expect(await exec(host, remoteRunnerService(action))).toEqual({ code: 0, calls: [`systemctl --user ${action} dori-runner.service`] });
  }
});

test("on Darwin, restart kickstarts the service in the recorded launchd domain", async () => {
  const host = fakeHost("Darwin");
  writeDomain(host, "user/501");
  expect(await exec(host, remoteRunnerService("restart"))).toEqual({ code: 0, calls: ["launchctl kickstart -k user/501/com.dori.runner"] });
});

test("on Darwin without a recorded domain, the gui domain of the uid is used", async () => {
  const host = fakeHost("Darwin");
  expect(await exec(host, remoteRunnerService("restart"))).toEqual({ code: 0, calls: ["launchctl kickstart -k gui/501/com.dori.runner"] });
});

test("on Darwin, stop disables the service and then boots it out", async () => {
  const host = fakeHost("Darwin");
  writeDomain(host, "gui/501");
  expect(await exec(host, remoteRunnerService("stop"))).toEqual({
    code: 0, calls: ["launchctl disable gui/501/com.dori.runner", "launchctl bootout gui/501/com.dori.runner"],
  });
});

test("a failing service manager makes the command fail", async () => {
  for (const os of ["Linux", "Darwin"] as const) {
    for (const action of ["restart", "stop"] as const) {
      const host = fakeHost(os, 3);
      expect((await exec(host, remoteRunnerService(action))).code).not.toBe(0);
    }
  }
});

test("remoteRunnerCli prefers the wrapper and falls back to bun on the PATH", async () => {
  const host = fakeHost("Linux");
  expect((await exec(host, remoteRunnerCli("runner probe --json"))).calls).toEqual([`bun ${host.home}/.dori/runner/bin/dori.js runner probe --json`]);
  const wrapper = join(host.home, ".dori/runner/bin/dori");
  mkdirSync(join(host.home, ".dori/runner/bin"), { recursive: true });
  writeFileSync(wrapper, `#!/bin/sh\nprintf 'wrapper %s\\n' "$*" >> '${host.log}'\n`);
  chmodSync(wrapper, 0o755);
  writeFileSync(host.log, "");
  expect((await exec(host, remoteRunnerCli("runner export-outbox"))).calls).toEqual(["wrapper runner export-outbox"]);
});
