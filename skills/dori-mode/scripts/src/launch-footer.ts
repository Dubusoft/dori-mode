import { languageInstruction } from "./config.ts";
import type { Lane } from "./registry.ts";
import { splitDone } from "./signals.ts";

/**
 * The done rules every footer carries, ahead of the lane's own values: how to claim, what the watcher checks, what happens
 * on a refusal. Every lane reports through its runner, so only the `dori` path differs between a local and a remote lane.
 * The rules every lane shares (no quotes, ids or usage numbers; no decision records in the repo; how to ask the owner) sit
 * here so a brief need not repeat them; the owner's own policy lines (`laneRules`: merge policy, CI policy) follow them.
 * Nothing lane-specific (key, thread, pane, Done line) may appear here; that is the "### This lane" section.
 */
/** The `dori` a lane runs: the runner's lane-mode CLI on a worker (installed by `dori runner install`), else the `dori` on PATH. */
export const laneCli = (lane: Pick<Lane, "machine">): string => (lane.machine ? RUNNER_LANE_CLI : "dori");
export const RUNNER_LANE_CLI = "~/.dori/runner/bin/dori";

/** Whether a `Done =` line names a `merged <repo>#N` signal (the PR the supervisor merges after the claim). */
const hasMergedSignal = (done: string): boolean => splitDone(done).some((part) => /^merged\s/i.test(part.trim()));

export const footerDoneRules = (lane: Lane, ownerLanguage?: string, laneRules: readonly string[] = []): string => [
  "- Rewritten paths under briefs/<key>.files are read-only snapshots of lead files; do not edit them. Write every output to DORI_LANE_OUT, including updated versions of an attached file.",
  "- The lead can add files there while you run (dori attach) and tells you their paths; they are read-only like the rest. A missing file the brief names was not shipped: ask the lead to attach it rather than working without it.",
  '- Write report files in DORI_LANE_OUT (POSIX: "$DORI_LANE_OUT"; PowerShell: "$env:DORI_LANE_OUT"). Finish writing before claiming done. dori ships that entire directory to the lead when you run claim-done or report done; files elsewhere are not collected. Keep each file at or below 262144 bytes and the directory at or below 393216 bytes total, with at most 64 files.',
  "- Set a goal restating the deliverable and its end condition (the `Done =` signals below decide the close), and work until it holds without asking leave for reversible steps the brief covers.",
  "- Done: once every `Done =` signal is live and all work is pushed, run the done command below, then stop and stay idle. A lane ends at its green PR: never wait for the merge (no monitor, wait, sleep, polling loop or `gh pr checks --watch` on it). The supervisor merges the PR at the head your claim recorded and the watcher closes the lane after that merge (5 min after the claim when nothing is left to merge) unless the Dori objects; it refuses while a worktree has uncommitted or unpushed changes. On `[LEAD] not done: <reasons>`, fix them and claim again.",
  ...(hasMergedSignal(lane.done) ? ["  A `merged` signal is the supervisor's to make live: claim done once the PR is pushed and its CI is running or green. Push nothing after the claim, or claim again if you must."] : []),
  "- Repo text (PRs, issues, commits, comments, docs) carries no owner quotes, chat ids, usage or cost numbers, decision logs or chat records; describe the change in your own words.",
  "- Ask the owner only what the owner alone can decide: money or a subscription, input only the owner can give, a product or business direction with no right answer, or an operational change or deletion that is hard to undo. Any other technical choice is yours: decide it, go ahead, and say what you chose in a milestone. A blocker the lead can clear (a missing attached file, a tool to install, a sandbox path, a check on the Mac or another machine, a credential) goes to the lead as `blocked`, never as a question.",
  "- Owner decisions go only through the dori report question command below (the owner never sees on-screen prompts); wait for the answer. A question while a blocking one of yours still waits joins that decision's thread. Form: `dori report <key> question --text \"<question>\" --option \"<A>\" --option \"<B>\" --recommend 1 --reason \"<why>\" [--waiting \"<what is paused>\"] [--nonblocking]` (2-9 options; a question without --option is refused, use `blocked` for an open-ended blocker). Each question opens a decision thread for the owner unless it joins your open blocking one. If an older dori on a worker machine rejects --option (an unknown-option error of any shape), send the same question with --text only, listing the options in the text.",
  "- Owner input (a one-time code such as a 2FA, login or device code; a file or value only the owner can give) goes only through `dori report <key> request --text \"<what you need>\" --reason \"<why>\" [--file <path>] [--waiting \"<what is paused>\"] [--nonblocking]`; wait for the answer, which the Dori relays. A blocking request opens one [요청] thread for the owner, in the same channel as decisions (or joins your open blocking decision's thread), and the owner replies there. Never ask for a long-lived secret (password, API key, token) in Discord: name with --file the path the owner writes it to (chmod 600) and read it from there; such a request without --file is refused. If an older dori rejects the request kind, send the same content as `blocked --text`. A check the work does not wait on (a real device or real account after the merge) is not a request: note it in your report; a `--nonblocking` request reaches only the lead, never the owner.",
  "- The lane's omo never stops on a permission prompt: access outside the lane sandbox (on a lane without one, outside its directory, the runner directory, the repos and worktree roots and the temp directory) is refused with an error instead. Work inside those paths (the worktree, the brief, DORI_LANE_OUT); when the work needs another path, report it to the lead as blocked with the path and why.",
  `- Every stored secret arrives in the lane environment at launch and is inherited by commands and their shells. GitHub access uses GH_TOKEN directly: gh and git push https://... read it. Production deploys and host work go only through \`${laneCli(lane)} secret run <op>\` / \`${laneCli(lane)} host <op>\`; these run registered config secretCommands operations on the supervisor host and print redacted output. A refused op lists the ops this lane may run.`,
  ...(languageInstruction(ownerLanguage) ? [`- ${languageInstruction(ownerLanguage)}`] : []),
  `- Run emulators, simulators and heavy builds (expo export, gradle, xcodebuild) only through \`${laneCli(lane)} heavy <label> -- <command>\` (one per machine; it waits for the slot).`,
  `- BrowserSkill (bsk) on macOS connects only while a Chrome window is open in the extension's profile. Before using it, and again after a \`bsk close\` that may have closed the last window, run \`bsk browsers\`; if it shows no browser, open a window yourself with \`open -b com.google.Chrome\` (no URL) and recheck for up to about 10 seconds. If it still shows none and \`pgrep -f -- --extension-process\` finds nothing, Chrome's profile or extension is at fault: send \`${laneCli(lane)} report <key> question\` asking the owner to check the Chrome sign-in and the BrowserSkill extension on that Mac. Never kill or restart Chrome, never use osascript, never open Chrome with a URL.`,
  ...laneRules.map((rule) => `- ${rule}`),
  ...(lane.autoClose === "machine" ? ["- autoClose: machine. When the Done signals read back live the lane closes on its own; the lead is not woken for the claim or the close."] : []),
].join("\n");

const FOOTER_HEADING = "\n## Lane footer (written by dori launch)";

/** The footer line placing a lane's git worktrees under its machine's reported worktree root. */
const worktreeLine = (root: string, key: string): string =>
  `- Create every git worktree this lane needs under ${root}, as ${root}/<repo name>-${key} (<repo name>: the last segment of owner/repo).`;

/**
 * The footer line telling a lane what its sandbox lets it touch, the same table `lane-sandbox --explain` prints on its
 * host (templates/lane-sandbox.sh and lane-sandbox-macos.sh); a lane without a sandbox is told it has none.
 */
const sandboxLine = (lane: Pick<Lane, "sandbox">): string => lane.sandbox
  ? "- Sandbox permissions: writable = the cwd and its git dir, DORI_LANE_OUT, the runner's worktree root and each .git under its repos root (hooks stay read-only), TMPDIR, /tmp, ~/.omo, ~/.cache and the package caches, plus write grants. Read-only = the system, the rest of $HOME and ~/.dori (dori, its config and the research dirs included), the brief and briefs/<key>.files, ~/.ssh known_hosts and config, ~/.config/git and gh's config without its hosts.yml login, plus read grants. Hidden = ~/.dori/runner but the lane's own entries (other lanes' briefs and tokens, the control sockets), ~/.dori/env, secrets, state, lane-sandbox-hide and gateway-locks, gh's hosts.yml login and ~/.npmrc (GitHub and registry tokens arrive in the lane environment at launch), the rest of ~/.ssh and ~/.config, credential stores (cloud, kube, gpg, keyrings, docker, git and registry logins, browser and chat app profiles, shell history), docker sockets and every path or glob in the host's ~/.dori/lane-sandbox-hide, applied after the cwd and grants so neither re-opens them on Linux. On macOS a hidden path is refused for reads (EPERM) after every grant but its name still lists, and only the lane-sandbox-hide entries and ~/.dori/secrets are refused for writes after the grants too, so a write grant or cwd covering another hidden path makes it writable (still unreadable). The exact table is what `lane-sandbox --explain` prints on the host."
  : "- Sandbox permissions: none. This lane runs without a lane sandbox, so only omo's own path rules bound it.";

/** The footer line naming a lane's path grants; the paths themselves live in its runner's runner-config.json. */
const grantLine = (grants: readonly string[]): string =>
  `- Path grants: ${grants.join(", ")} (its runner's runner-config.json grants table names the paths). Those paths are writable or readable inside the sandbox as the table says; the hide list still wins, and nothing else outside the lane sandbox opens.`;

/** The kinds of a `dori report` footer and where each goes. */
const REPORT_KINDS_TEXT = "milestone = what landed, standing vs Done, scope change; progress = 1-2 lines (updates the thread status); question (with --option choices, see the owner-decision rule above), request (owner input, see the owner-input rule above) and blocked wake the lead.";

/**
 * The footer every lane brief gets: the shared done rules, then this lane's values and how it reports through its runner.
 * `worktreeRoot`, the lane worktree root its machine's runner reported, adds where the lane creates its git worktrees.
 */
export const footer = (lane: Lane, ownerLanguage?: string, laneRules?: readonly string[], worktreeRoot?: string): string => [
  "",
  FOOTER_HEADING.slice(1),
  footerDoneRules(lane, ownerLanguage, laneRules),
  "",
  "### This lane",
  `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
  `- Done = ${lane.done}`,
  ...(worktreeRoot ? [worktreeLine(worktreeRoot.replace(/\/+$/, ""), lane.key)] : []),
  sandboxLine(lane),
  ...(lane.grants?.length ? [grantLine(lane.grants)] : []),
  ...(lane.fileRun?.requiredReport ? ["- This lane declares deliverable: report. Write at least one regular report file in DORI_LANE_OUT before claiming done."] : []),
  ...(lane.machine
    ? [
      `- Runs on machine ${lane.machine} under its runner. Report only with: ${RUNNER_LANE_CLI} report ${lane.key} <milestone|progress|question|request|blocked> --text "<what, with links>" (never type into a pane). ${REPORT_KINDS_TEXT} That CLI takes only report, claim-done, report ack, lane status, heavy, secret env and secret run (alias host), and only for this lane's key.`,
      `- When done: ${RUNNER_LANE_CLI} report ${lane.key} done --text "<one line>" --evidence "<PR link and head SHA, closed issue, version>".`,
    ]
    : [
      `- Report only with: dori report ${lane.key} <milestone|progress|question|request|blocked> --text "<what, with links>" (never type into a pane). ${REPORT_KINDS_TEXT}`,
      `- When done: dori report ${lane.key} done --text "<one line>" --evidence "<PR link and head SHA, closed issue, version>".`,
    ]),
  "",
].join("\n");
