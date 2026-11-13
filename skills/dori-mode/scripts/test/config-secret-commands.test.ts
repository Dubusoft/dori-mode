import { expect, test } from "bun:test";
import { join } from "node:path";

import { CONFIG_FILE_KEYS, defaultConfig, loadConfig } from "../src/config.ts";
import { withState } from "./fakes.ts";

const state = withState();

const load = async (name: string, body: unknown) => {
  const path = join(state.dir, `${name}.json`);
  await Bun.write(path, JSON.stringify(body));
  return loadConfig(path, "/home/ana");
};

const OP = { argv: ["deploy", "--prod"], secrets: ["DEPLOY_TOKEN"], lanes: ["rel-*"], repos: ["Dubusoft/dori-mode"] };

test("secretCommands is a config file key and defaults to none", async () => {
  expect(CONFIG_FILE_KEYS).toContain("secretCommands");
  expect(defaultConfig("/home/ana").secretCommands).toEqual({});
  expect((await load("none", {})).secretCommands).toEqual({});
});

test("a valid op loads with the default timeout, and optional fields are kept", async () => {
  const c = await load("valid", { secretCommands: { "deploy-prod": OP, "bare": { argv: ["x"], secrets: [], lanes: ["a"], repos: [], timeoutSec: 3600, cwd: "/srv/app" } } });
  expect(c.secretCommands["deploy-prod"]).toEqual({ ...OP, timeoutSec: 300 });
  expect(c.secretCommands.bare).toEqual({ argv: ["x"], secrets: [], lanes: ["a"], repos: [], timeoutSec: 3600, cwd: "/srv/app" });
});

test("a host command may leave out secrets and repos", async () => {
  const c = await load("host", { secretCommands: { "probe-sandbox": { argv: ["/home/u/.dori/ops/probe.sh"], lanes: ["*"] } } });
  expect(c.secretCommands["probe-sandbox"]).toEqual({ argv: ["/home/u/.dori/ops/probe.sh"], secrets: [], lanes: ["*"], repos: [], timeoutSec: 300 });
});

test("an invalid op throws TypeError", async () => {
  const bad: [string, unknown][] = [
    ["not an object", ["deploy"]],
    ["upper-case op name", { Deploy: OP }],
    ["op starting with a digit", { "1deploy": OP }],
    ["op name too long", { [`a${"b".repeat(64)}`]: OP }],
    ["op not an object", { deploy: "x" }],
    ["empty argv", { deploy: { ...OP, argv: [] } }],
    ["missing argv", { deploy: { secrets: [], lanes: [], repos: [] } }],
    ["empty argv element", { deploy: { ...OP, argv: ["a", ""] } }],
    ["non-string argv element", { deploy: { ...OP, argv: ["a", 1] } }],
    ["bad secret name", { deploy: { ...OP, secrets: ["lower_case"] } }],
    ["secrets not a list", { deploy: { ...OP, secrets: "A" } }],
    ["timeout zero", { deploy: { ...OP, timeoutSec: 0 } }],
    ["timeout too big", { deploy: { ...OP, timeoutSec: 3601 } }],
    ["timeout fractional", { deploy: { ...OP, timeoutSec: 1.5 } }],
    ["timeout string", { deploy: { ...OP, timeoutSec: "5" } }],
    ["relative cwd", { deploy: { ...OP, cwd: "work/dir" } }],
    ["unknown field", { deploy: { ...OP, env: {} } }],
  ];
  for (const [i, [what, secretCommands]] of bad.entries()) {
    await expect(load(`bad-${i}`, { secretCommands }), what).rejects.toBeInstanceOf(TypeError);
  }
});
