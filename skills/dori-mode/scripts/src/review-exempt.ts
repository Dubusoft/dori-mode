import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isRepoRelativePath, type ReviewSnapshot, snapshotKey } from "./review-receipt.ts";
import { withStateLockSync } from "./state-lock.ts";
import { saveJsonFile } from "./store.ts";

/**
 * Narrow non-code exemption from the pre-merge review (design 5.7, T6). Only a small, modify-only edit of plain prose in
 * allowlisted Markdown files is exempt; everything else, and anything the classifier cannot decide, is reviewed. The
 * supervisor records the outcome per snapshot as an {@link ExemptReceipt} (`kind: "exempt"`), never as a reviewer pass.
 */

/** Bumped whenever a rule below changes: every earlier exemption is then classified again. */
export const EXEMPT_POLICY_VERSION = "t6-1";
export const EXEMPT_MAX_FILES = 3;
export const EXEMPT_MAX_LINES = 80;

/** The allowlist: rule id and the paths it admits. Each also requires `.md` and passes the deny rules. */
const PATH_RULES: readonly { readonly id: string; readonly match: (p: string) => boolean }[] = [
  { id: "path:readme", match: (p) => p === "README.md" },
  { id: "path:changelog", match: (p) => p === "CHANGELOG.md" },
  { id: "path:docs", match: (p) => p.startsWith("docs/") && p.endsWith(".md") },
  { id: "path:blog", match: (p) => p.startsWith("blog/") && p.endsWith(".md") },
  { id: "path:content-blog", match: (p) => p.startsWith("content/blog/") && p.endsWith(".md") },
];
/** Agent instructions, skills and policy are reviewed whatever their extension or size. */
const DENY_SEGMENTS: ReadonlySet<string> = new Set([".omo", ".github", "skills", "policies"]);
const DENY_NAMES: ReadonlySet<string> = new Set(["skill.md", "agents.md", "claude.md"]);
/** Condition rule ids every exemption satisfies, recorded with the matched path rules. */
const CONDITION_RULES = ["diff:modify-only", `limit:files<=${EXEMPT_MAX_FILES}`, `limit:lines<=${EXEMPT_MAX_LINES}`, "content:prose-only"] as const;

/** Words naming install, deploy, permission, auth, security or operations steps: a changed line with one is reviewed. */
const SENSITIVE = /install|deploy|permission|auth|token|secret|password|credential|sudo|chmod|security|설치|배포|권한|인증|보안|비밀/i;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** One hunk line: its kind and text (without the leading marker). */
type HunkLine = { readonly kind: " " | "+" | "-"; readonly text: string };
type Hunk = { readonly oldStart: number; readonly newStart: number; readonly lines: readonly HunkLine[] };
/** One file of a parsed diff that is a plain in-place modification of a regular file. */
export type DiffFile = { readonly path: string; readonly hunks: readonly Hunk[]; readonly additions: number; readonly deletions: number };

export type ParsedDiff = { readonly ok: true; readonly files: readonly DiffFile[] } | { readonly ok: false; readonly reason: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const INDEX_REGULAR = /^index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64} 100644$/;

/**
 * Parses a `git diff` (GitHub compare) text, accepting only in-place modifications of regular, non-executable text files.
 * Any other header (new, deleted, renamed, copied, mode change, symlink or submodule mode, binary) or anything the parser
 * does not recognize is a refusal with its reason, never a guess.
 */
export const parseModifyOnlyDiff = (diff: string): ParsedDiff => {
  const no = (reason: string): ParsedDiff => ({ ok: false, reason });
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return no("empty diff");
  const files: DiffFile[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = lines[i]!;
    if (!head.startsWith("diff --git ")) return no(`unexpected line ${i + 1}: ${head.slice(0, 80)}`);
    i++;
    const header: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith("--- ") && !lines[i]!.startsWith("diff --git ")) header.push(lines[i++]!);
    if (header.length !== 1 || !INDEX_REGULAR.test(header[0]!)) {
      return no(`not a plain modification of a regular file: ${(header.find((h) => !h.startsWith("index ")) ?? header[0] ?? head).slice(0, 80)}`);
    }
    const minus = lines[i] ?? "", plus = lines[i + 1] ?? "";
    if (!minus.startsWith("--- a/") || !plus.startsWith("+++ b/")) return no(`missing ---/+++ header after ${head.slice(0, 80)}`);
    const path = minus.slice(6);
    if (plus.slice(6) !== path || head !== `diff --git a/${path} b/${path}`) return no(`path mismatch in ${head.slice(0, 80)}`);
    if (!isRepoRelativePath(path) || /[\s"\\]/.test(path)) return no(`unsupported path ${JSON.stringify(path)}`);
    i += 2;
    const hunks: Hunk[] = [];
    let additions = 0, deletions = 0;
    while (i < lines.length && !lines[i]!.startsWith("diff --git ")) {
      const m = HUNK_HEADER.exec(lines[i]!);
      if (!m) return no(`${path}: unexpected line ${i + 1}: ${lines[i]!.slice(0, 80)}`);
      i++;
      let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      let newLeft = m[4] === undefined ? 1 : Number(m[4]);
      const body: HunkLine[] = [];
      while (oldLeft > 0 || newLeft > 0) {
        const l = lines[i];
        if (l === undefined) return no(`${path}: hunk ends early`);
        i++;
        if (l.startsWith("\\")) continue;
        const kind = l[0];
        if (kind === " ") { oldLeft--; newLeft--; } else if (kind === "-") { oldLeft--; deletions++; } else if (kind === "+") { newLeft--; additions++; } else {
          return no(`${path}: bad hunk line ${i}: ${l.slice(0, 80)}`);
        }
        if (oldLeft < 0 || newLeft < 0) return no(`${path}: hunk line counts do not match its header`);
        body.push({ kind, text: l.slice(1) });
      }
      while (lines[i]?.startsWith("\\")) i++;
      hunks.push({ oldStart: Number(m[1]), newStart: Number(m[3]), lines: body });
    }
    if (hunks.length === 0) return no(`${path}: no hunks`);
    files.push({ path, hunks, additions, deletions });
  }
  return { ok: true, files };
};

/** The allowlist rule id of `path`, or undefined when it is not allowlisted or a deny rule applies. */
export const exemptPathRule = (path: string): string | undefined => {
  const segs = path.split("/");
  if (segs.some((s) => DENY_SEGMENTS.has(s) || s.startsWith("."))) return undefined;
  if (DENY_NAMES.has(segs.at(-1)!.toLowerCase())) return undefined;
  return PATH_RULES.find((r) => r.match(path))?.id;
};

/** Per line of a Markdown file: true when it is not plain prose (fenced code, front matter). Index 0 is line 1. */
const nonProseLines = (lines: readonly string[]): boolean[] => {
  const out = lines.map(() => false);
  let i = 0;
  const fm = lines[0]?.trimEnd();
  if (fm === "---" || fm === "+++") {
    out[0] = true;
    for (i = 1; i < lines.length; i++) {
      out[i] = true;
      if (lines[i]!.trimEnd() === fm) { i++; break; }
    }
  }
  let fence: { readonly ch: string; readonly len: number } | undefined;
  for (; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
    if (fence) {
      out[i] = true;
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && m[2]!.trim() === "") fence = undefined;
    } else if (m && !(m[1]![0] === "`" && m[2]!.includes("`"))) {
      out[i] = true;
      fence = { ch: m[1]![0]!, len: m[1]!.length };
    }
  }
  return out;
};

/** Link and image targets, reference labels and definitions, bare URLs and inline code spans of `text`, sorted. */
const anchors = (text: string): string[] => {
  const out: string[] = [];
  for (const re of [/\]\(\s*([^)\s]*)/g, /\]\[([^\]]*)\]/g, /^\s*\[[^\]]+\]:\s*(\S+)/gm, /([a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+)/gi, /(mailto:[^\s)>\]]+)/gi, /(`+[^`]*`+)/g]) {
    for (const m of text.matchAll(re)) out.push(`${re.source}\u0000${m[1]}`);
  }
  return out.sort();
};

/** Why a changed line is not plain prose, or undefined when it is. */
const lineProblem = (text: string): string | undefined => {
  if (/^( {4}|\t)/.test(text)) return "indented code";
  if (/^ {0,3}(`{3,}|~{3,})/.test(text)) return "code fence";
  if (/<[A-Za-z!/?]/.test(text)) return "HTML/JSX/MDX";
  if (/\{\{|\{%|<%|\$\{/.test(text)) return "template syntax";
  if (/^\s*\$ /.test(text)) return "shell command";
  if (SENSITIVE.test(text)) return "install/deploy/permission/auth/security wording";
  return undefined;
};

export type ExemptClassification =
  | {
      readonly exempt: true;
      readonly ruleIds: readonly string[];
      readonly files: readonly string[];
      readonly additions: number;
      readonly deletions: number;
    }
  | { readonly exempt: false; readonly reason: string };

/** Reads one file's text at the diff's base (`"base"`, the merge base) or head side. */
export type ReadSide = (side: "base" | "head", path: string) => Promise<string>;

/**
 * Decides whether the `mergeBase...head` diff is exempt from review (design 5.7 rules 1-7 and the config rule). The diff
 * must be a modify-only change of at most {@link EXEMPT_MAX_FILES} allowlisted Markdown files and at most
 * {@link EXEMPT_MAX_LINES} added plus deleted lines. Each file is read at both sides and the hunks must match it line by
 * line; every changed line must lie outside fences and front matter on both sides, be plain prose, and leave the file's
 * link targets and code spans unchanged. A read failure or any mismatch refuses the exemption.
 */
export const classifyExemption = async (diff: string, read: ReadSide): Promise<ExemptClassification> => {
  const no = (reason: string): ExemptClassification => ({ exempt: false, reason });
  const parsed = parseModifyOnlyDiff(diff);
  if (!parsed.ok) return no(parsed.reason);
  const files = parsed.files;
  if (files.length > EXEMPT_MAX_FILES) return no(`${files.length} files changed (at most ${EXEMPT_MAX_FILES})`);
  const total = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (total > EXEMPT_MAX_LINES) return no(`${total} lines changed (at most ${EXEMPT_MAX_LINES})`);
  const ruleIds = new Set<string>();
  for (const f of files) {
    const rule = exemptPathRule(f.path);
    if (!rule) return no(`${f.path} is not an exempt path`);
    ruleIds.add(rule);
  }
  for (const f of files) {
    let base: string, head: string;
    try { [base, head] = await Promise.all([read("base", f.path), read("head", f.path)]); } catch (e) {
      return no(`${f.path} unreadable: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
    const oldLines = base.split("\n"), newLines = head.split("\n");
    const oldCode = nonProseLines(oldLines), newCode = nonProseLines(newLines);
    const removed: string[] = [], added: string[] = [];
    for (const h of f.hunks) {
      let o = h.oldStart - 1, n = h.newStart - 1;
      for (const l of h.lines) {
        if (l.kind !== "+" && oldLines[o] !== l.text) return no(`${f.path}: diff does not match the base file at line ${o + 1}`);
        if (l.kind !== "-" && newLines[n] !== l.text) return no(`${f.path}: diff does not match the head file at line ${n + 1}`);
        if (l.kind === "-" && oldCode[o]) return no(`${f.path}:${o + 1} (base) is inside a code fence or front matter`);
        if (l.kind === "+" && newCode[n]) return no(`${f.path}:${n + 1} is inside a code fence or front matter`);
        if (l.kind !== " ") {
          const problem = lineProblem(l.text);
          if (problem) return no(`${f.path}:${l.kind === "+" ? n + 1 : o + 1}: ${problem}`);
          (l.kind === "+" ? added : removed).push(l.text);
        }
        if (l.kind !== "+") o++;
        if (l.kind !== "-") n++;
      }
    }
    const before = anchors(removed.join("\n")), after = anchors(added.join("\n"));
    if (before.length !== after.length || before.some((a, k) => a !== after[k])) return no(`${f.path}: a link target, URL or code span changed`);
  }
  return {
    exempt: true,
    ruleIds: [...[...ruleIds].sort(), ...CONDITION_RULES],
    files: files.map((f) => f.path),
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
};

/** The supervisor's record that one exact snapshot is exempt. Distinct from a reviewer receipt: no reviewer, no verdict. */
export type ExemptReceipt = {
  readonly schemaVersion: 1;
  readonly kind: "exempt";
  readonly receiptId: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly policyVersion: string;
  readonly criteriaSha256: string;
  readonly exemptPolicyVersion: string;
  readonly ruleIds: readonly string[];
  readonly files: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly diffSha256: string;
  readonly classifiedAt: string;
};

/** A classification outcome stored per snapshot: an exemption, or the reason the snapshot is reviewed. */
export type ExemptDecision =
  | { readonly kind: "exempt"; readonly key: string; readonly receipt: ExemptReceipt }
  | { readonly kind: "review"; readonly key: string; readonly reason: string; readonly classifiedAt: string };

/** The store key of a snapshot under the current exemption policy: a new head, base or policy is a new key. */
export const exemptKey = (s: ReviewSnapshot): string => `${snapshotKey(s)}/${EXEMPT_POLICY_VERSION}`;

export const exemptReceipt = (
  s: ReviewSnapshot, c: Extract<ExemptClassification, { exempt: true }>, diffSha256: string, now: number,
): ExemptReceipt => ({
  schemaVersion: 1,
  kind: "exempt",
  receiptId: `rx_${sha256([exemptKey(s), diffSha256].join("\n")).slice(0, 32)}`,
  repo: s.repo, prNumber: s.prNumber, headSha: s.headSha, baseRef: s.baseRef, baseSha: s.baseSha, mergeBaseSha: s.mergeBaseSha,
  policyVersion: s.policyVersion, criteriaSha256: s.criteriaSha256, exemptPolicyVersion: EXEMPT_POLICY_VERSION,
  ruleIds: c.ruleIds, files: c.files, additions: c.additions, deletions: c.deletions, diffSha256,
  classifiedAt: new Date(now).toISOString(),
});

/** True only when `r` is an exemption of exactly the observed snapshot under the current exemption policy. */
export const isExemptFor = (r: ExemptReceipt, observed: ReviewSnapshot): boolean =>
  r.kind === "exempt" &&
  r.exemptPolicyVersion === EXEMPT_POLICY_VERSION &&
  exemptKey({
    repo: r.repo, prNumber: r.prNumber, headSha: r.headSha, baseRef: r.baseRef, baseSha: r.baseSha, mergeBaseSha: r.mergeBaseSha,
    policyVersion: r.policyVersion, criteriaSha256: r.criteriaSha256,
  }) === exemptKey(observed);

export const REVIEW_EXEMPT_FILE = "review-exempt.json";
const REVIEW_EXEMPT_LOCK = "review-exempt.lock.sqlite";

/** `review-exempt.json`: one decision per snapshot key, written once (the first decision for a key stands). */
export class ReviewExemptions {
  readonly path: string;
  private readonly lock: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, REVIEW_EXEMPT_FILE);
    this.lock = join(stateDir, REVIEW_EXEMPT_LOCK);
  }
  private read(): Record<string, ExemptDecision> {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as { decisions: Record<string, ExemptDecision> }).decisions : {};
  }
  get(key: string): ExemptDecision | undefined { return this.read()[key]; }
  list(): ExemptDecision[] { return Object.values(this.read()); }
  /** Stores `decision` unless its key already has one; returns the decision that stands. */
  record(decision: ExemptDecision): ExemptDecision {
    return withStateLockSync(this.lock, () => {
      const all = this.read();
      const known = all[decision.key];
      if (known) return known;
      all[decision.key] = decision;
      saveJsonFile(this.path, { decisions: all });
      return decision;
    });
  }
}
