import { join } from "node:path";
import { resumeArgv } from "./lane-control.ts";
import type { RunnerPolicy } from "./policy.ts";

export const quote = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * The line typed into a Windows lane's hc terminal (Windows PowerShell 5.1): a nested `powershell -NoLogo
 * -EncodedCommand <base64(utf16le(script))>`, so the variables live only in the nested process and the typed text is
 * plain base64. PowerShell 5.1 mangles native arguments containing a double quote, so such an argv is refused
 * (`RUNNER_LANE_ARGV_UNSAFE`). The nested shell enters `cwd` before the agent starts: it loads the user's profile, and a
 * profile that changes directory would otherwise start the agent outside the lane's directory.
 */
export const powershellLaunchLine = (env: readonly (readonly [string, string])[], argv: readonly string[], cwd: string): string => {
  if (argv.some((arg) => arg.includes('"'))) {
    throw new Error("RUNNER_LANE_ARGV_UNSAFE Windows PowerShell 5.1 cannot pass an argument containing a double quote");
  }
  const script = [
    ...env.map(([name, value]) => `$env:${name}=${psQuote(value)}`),
    "$env:PSExecutionPolicyPreference='Bypass'",
    `Set-Location -LiteralPath ${psQuote(cwd)}`,
    `& ${argv.map(psQuote).join(" ")}`,
    "exit $LASTEXITCODE",
  ].join("; ");
  return `powershell -NoLogo -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
};

/** The old lane `.omo/mcp.json` (figma disabled) that launch.ts used to write; the same bytes as `LEGACY_LANE_MCP` there. */
export const LEGACY_LANE_MCP = `${JSON.stringify({ mcpServers: { figma: { enabled: false, url: "https://mcp.figma.com/mcp" } } }, null, 2)}\n`;

/**
 * Removes a `.omo/mcp.json` in `cwd` that is byte-for-byte the old lane file, so an old worktree stops keeping figma
 * off; a user's own file is never touched. Runs on the lane's host before the agent starts (moved from launch.ts).
 */
export const removeLegacyLaneMcp = async (cwd: string): Promise<boolean> => {
  const file = Bun.file(join(cwd, ".omo", "mcp.json"));
  try {
    if (!(await file.exists()) || (await file.text()) !== LEGACY_LANE_MCP) return false;
    await file.delete();
    return true;
  } catch { return false; } // unremovable: the lane still launches as before
};

/**
 * omo's permission preset for every lane. A lane's pane has no one to answer omo's interactive permission prompt, and a
 * host whose omo settings pick a stricter preset (`workspace`, `ask`) would stop the lane on it. Under `full-access` omo
 * never prompts: a configured `deny` rule still refuses, and the lane sandbox, not omo, bounds what the lane can reach.
 */
export const LANE_PERMISSION_FLAGS: readonly string[] = ["--permission-preset", "full-access"];

/**
 * Turns off omo's on-screen question tool for a lane. Nobody watches a lane's pane, so a lane asks with `dori report
 * question`; omo gives its subagents (task children, workflow nodes) no question tool, so the lane itself was the only
 * session that could open one. Written with its value: omo reads a bare unknown `--flag` followed by a plain argument as
 * that flag's value, so `--no-ask-user` right before the prompt would swallow the prompt.
 */
export const LANE_NO_ASK_FLAG = "--no-ask-user=true";

/**
 * The omo `--permission` value for a lane whose machine opted in to run unsandboxed, where
 * full-access alone would leave nothing in place: every path outside the lane's cwd is refused without a prompt, except
 * each `allowed` directory and everything under it. A directory whose path holds `,` or `=` cannot be written as an omo
 * rule, so it stays refused.
 */
export const outsideDenyRules = (allowed: readonly string[], join: (dir: string, name: string) => string): string => [
  "external_directory=deny",
  ...[...new Set(allowed)].filter((dir) => dir !== "" && !/[,=]/.test(dir))
    .flatMap((dir) => [`external_directory:${dir}=allow`, `external_directory:${join(dir, "*")}=allow`]),
].join(",");

/**
 * `template` with LANE_PERMISSION_FLAGS (and `--permission <outsideRules>` when given) and LANE_NO_ASK_FLAG before its
 * `{prompt}` slot. The permission flags are left out when it already names a preset, the no-ask flag when it already
 * has it; a template without a slot is unchanged.
 */
export const lanePermissionArgv = (template: readonly string[], outsideRules?: string): readonly string[] => {
  const at = template.findIndex((part) => part.includes("{prompt}"));
  if (at < 1) return template;
  const preset = template.some((part) => /^--permission-preset(?:=|$)/.test(part));
  const flags = [
    ...(preset ? [] : [...LANE_PERMISSION_FLAGS, ...(outsideRules ? ["--permission", outsideRules] : [])]),
    ...(template.some((part) => /^--no-ask-user(?:=|$)/.test(part)) ? [] : [LANE_NO_ASK_FLAG]),
  ];
  return [...template.slice(0, at), ...flags, ...template.slice(at)];
};

/** The model an agent argv names (`--model X` or `--model=X`), or undefined when it names none. */
export const argvModel = (argv: readonly string[]): string | undefined => {
  const at = argv.indexOf("--model");
  return (at >= 0 ? argv[at + 1] : argv.find((arg) => arg.startsWith("--model="))?.slice(8)) || undefined;
};

/**
 * The agent argv of `profile`, each `{prompt}`, `{model}` and `{brief}` filled in, with the lane permission flags
 * (`lanePermissionArgv`, `outsideRules` for an unsandboxed lane); `session` resumes it when the profile allows (`resumeArgv`).
 */
export const agentArgv = (
  policy: RunnerPolicy, profile: string, values: { readonly prompt: string; readonly model: string; readonly brief: string }, session?: string,
  outsideRules?: string,
): string[] => {
  const configured = policy.agents[profile];
  if (!configured?.length) throw new Error(`RUNNER_LANE_PROFILE_UNKNOWN ${profile}`);
  const template = lanePermissionArgv(configured, outsideRules);
  const parts = resumeArgv(template, session) ?? template;
  return parts.map((part) => part.replaceAll("{prompt}", values.prompt).replaceAll("{model}", values.model).replaceAll("{brief}", values.brief));
};
