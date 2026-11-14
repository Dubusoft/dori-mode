import { expect, test } from "bun:test";

import {
  classifyExemption, EXEMPT_POLICY_VERSION, exemptKey, exemptReceipt, isExemptFor, parseModifyOnlyDiff, type ReadSide,
} from "../src/review-exempt.ts";
import { isApproval, type ReviewReceipt, type ReviewSnapshot } from "../src/review-receipt.ts";

/**
 * T6 classifier fixtures (design 5.7): a diff text plus the base and head file contents it was made from. A change is a
 * line range of the base file replaced by new lines; the hunk carries no context lines.
 */

type Fx = { readonly diff: string; readonly read: ReadSide };

const DOC = ["# Title", "", "Some prose with a [link](https://example.com/a) here.", "", "A second paragraph.", ""];

/** One modified file: `count` base lines from line `at` (1-based) replaced by `lines`. */
const change = (path: string, base: readonly string[], at: number, count: number, lines: readonly string[], header = "index 1111111..2222222 100644") => {
  const head = [...base.slice(0, at - 1), ...lines, ...base.slice(at - 1 + count)];
  const diff = [
    `diff --git a/${path} b/${path}`, header, `--- a/${path}`, `+++ b/${path}`,
    `@@ -${at},${count} +${at},${lines.length} @@`, ...base.slice(at - 1, at - 1 + count).map((l) => `-${l}`), ...lines.map((l) => `+${l}`),
  ].join("\n");
  return { path, diff, base: base.join("\n"), head: head.join("\n") };
};

const fx = (...files: ReturnType<typeof change>[]): Fx => ({
  diff: `${files.map((f) => f.diff).join("\n")}\n`,
  read: async (side, path) => {
    const f = files.find((x) => x.path === path);
    if (!f) throw new Error(`no ${path}`);
    return side === "base" ? f.base : f.head;
  },
});

const prose = (path = "docs/guide.md") => change(path, DOC, 5, 1, ["A second, clearer paragraph."]);

const reason = async (f: Fx): Promise<string> => {
  const c = await classifyExemption(f.diff, f.read);
  if (c.exempt) throw new Error("unexpectedly exempt");
  return c.reason;
};

test("a prose fix in each allowlisted path is exempt and records its path rule and the conditions", async () => {
  for (const [path, rule] of [
    ["README.md", "path:readme"], ["CHANGELOG.md", "path:changelog"], ["docs/a/b.md", "path:docs"], ["blog/post.md", "path:blog"],
    ["content/blog/2026/post.md", "path:content-blog"],
  ] as const) {
    const c = await classifyExemption(fx(prose(path)).diff, fx(prose(path)).read);
    expect(c).toEqual({ exempt: true, ruleIds: [rule, "diff:modify-only", "limit:files<=3", "limit:lines<=80", "content:prose-only"], files: [path], additions: 1, deletions: 1 });
  }
});

test("link text may change while its target stays; three files and exactly 80 lines are still exempt", async () => {
  const relinked = change("docs/a.md", DOC, 3, 1, ["Some prose with a [better link](https://example.com/a) here."]);
  expect((await classifyExemption(fx(relinked).diff, fx(relinked).read)).exempt).toBe(true);
  const long = Array.from({ length: 40 }, (_, k) => `Line ${k}.`);
  const big = change("docs/long.md", long, 1, 38, long.slice(0, 38).map((l) => `${l} Fixed.`));
  const three = fx(big, prose("README.md"), prose("docs/b.md"));
  const c = await classifyExemption(three.diff, three.read);
  expect(c.exempt && c.additions + c.deletions).toBe(80);
});

test("limits: a fourth file or an 81st changed line is reviewed", async () => {
  expect(await reason(fx(prose("docs/a.md"), prose("docs/b.md"), prose("docs/c.md"), prose("docs/d.md")))).toBe("4 files changed (at most 3)");
  const long = Array.from({ length: 40 }, (_, k) => `Line ${k}.`);
  expect(await reason(fx(change("docs/long.md", long, 1, 40, [...long.map((l) => `${l} Fixed.`), "One more."])))).toBe("81 lines changed (at most 80)");
});

test("paths outside the allowlist, config of any size, and agent or skill documents are reviewed", async () => {
  for (const path of [
    "notes.md", "docs/guide.mdx", "docs/config.json", "config.yaml", ".env", "docs/SKILL.md", "skills/x/SKILL.md", "docs/skills/a.md", "AGENTS.md",
    ".github/README.md", "docs/.omo/a.md", "policies/a.md", "docs/README.txt",
  ]) {
    expect(await reason(fx(prose(path)))).toBe(`${path} is not an exempt path`);
  }
});

test("a mixed PR (one prose fix plus one code file) is reviewed as a whole", async () => {
  expect(await reason(fx(prose("docs/a.md"), change("src/a.ts", ["export const a = 1;"], 1, 1, ["export const a = 2;"])))).toBe("src/a.ts is not an exempt path");
});

test("added, deleted, renamed, mode-changed, symlink, submodule and binary files are reviewed", async () => {
  const cases: [string, string][] = [
    ["added", "diff --git a/docs/n.md b/docs/n.md\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/docs/n.md\n@@ -0,0 +1 @@\n+Hi.\n"],
    ["deleted", "diff --git a/docs/n.md b/docs/n.md\ndeleted file mode 100644\nindex 2222222..0000000\n--- a/docs/n.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-Hi.\n"],
    ["renamed", "diff --git a/docs/a.md b/docs/b.md\nsimilarity index 90%\nrename from docs/a.md\nrename to docs/b.md\nindex 1111111..2222222 100644\n--- a/docs/a.md\n+++ b/docs/b.md\n@@ -1 +1 @@\n-Hi.\n+Hello.\n"],
    ["pure rename", "diff --git a/docs/a.md b/docs/b.md\nsimilarity index 100%\nrename from docs/a.md\nrename to docs/b.md\n"],
    ["mode change", "diff --git a/docs/a.md b/docs/a.md\nold mode 100644\nnew mode 100755\n"],
    ["executable", "diff --git a/docs/a.md b/docs/a.md\nindex 1111111..2222222 100755\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-Hi.\n+Hello.\n"],
    ["symlink", "diff --git a/docs/a.md b/docs/a.md\nindex 1111111..2222222 120000\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-x.md\n\\ No newline at end of file\n+y.md\n\\ No newline at end of file\n"],
    ["submodule", "diff --git a/docs/sub b/docs/sub\nindex 1111111..2222222 160000\n--- a/docs/sub\n+++ b/docs/sub\n@@ -1 +1 @@\n-Subproject commit 1111111111111111111111111111111111111111\n+Subproject commit 2222222222222222222222222222222222222222\n"],
    ["binary", "diff --git a/docs/a.md b/docs/a.md\nindex 1111111..2222222 100644\nBinary files a/docs/a.md and b/docs/a.md differ\n"],
  ];
  for (const [name, diff] of cases) {
    const c = await classifyExemption(diff, async () => "Hi.");
    expect([name, c.exempt]).toEqual([name, false]);
  }
});

test("unknown formats and parser failures are never exempt", async () => {
  const good = prose().diff;
  for (const diff of [
    "", "not a diff\n", good.replace("@@ -5,1 +5,1 @@", "@@ -5,2 +5,1 @@"), good.replace("@@ -5,1 +5,1 @@", "@@ garbage @@"),
    good.replace("+++ b/docs/guide.md", "+++ b/docs/other.md"), good.replace("index 1111111..2222222 100644", ""), `${good}\ntrailing junk`,
    good.replace(/docs\/guide\.md/g, '"docs/gu ide.md"'),
  ]) {
    expect((await classifyExemption(diff, fx(prose()).read)).exempt).toBe(false);
  }
});

test("a file that cannot be read, or that does not match the diff, refuses the exemption", async () => {
  expect(await reason({ diff: prose().diff, read: async () => { throw new Error("HTTP 404"); } })).toBe("docs/guide.md unreadable: HTTP 404");
  expect(await reason({ diff: prose().diff, read: async () => "something else" })).toBe("docs/guide.md: diff does not match the base file at line 5");
});

test("content: fences, front matter, indented code, HTML/MDX, templates, URL targets, code spans and sensitive steps are reviewed", async () => {
  const fenced = ["# T", "", "```sh", "echo hi", "```", "", "Prose.", ""];
  const tilde = ["# T", "", "~~~", "run it", "~~~", ""];
  const front = ["---", "title: Old", "---", "", "Prose.", ""];
  const toml = ["+++", "title = 'Old'", "+++", "", "Prose.", ""];
  const cases: [string, ReturnType<typeof change>, string][] = [
    ["inside fence", change("docs/a.md", fenced, 4, 1, ["echo bye"]), "docs/a.md:4 (base) is inside a code fence or front matter"],
    ["inside tilde fence", change("docs/a.md", tilde, 4, 1, ["run that"]), "docs/a.md:4 (base) is inside a code fence or front matter"],
    ["new fence", change("docs/a.md", DOC, 5, 1, ["```", "code", "```"]), "docs/a.md:5 is inside a code fence or front matter"],
    ["yaml front matter", change("docs/a.md", front, 2, 1, ["title: New"]), "docs/a.md:2 (base) is inside a code fence or front matter"],
    ["toml front matter", change("docs/a.md", toml, 2, 1, ["title = 'New'"]), "docs/a.md:2 (base) is inside a code fence or front matter"],
    ["indented code", change("docs/a.md", DOC, 5, 1, ["    rm -rf x"]), "docs/a.md:5: indented code"],
    ["html", change("docs/a.md", DOC, 5, 1, ["A <b>bold</b> paragraph."]), "docs/a.md:5: HTML/JSX/MDX"],
    ["jsx", change("docs/a.md", DOC, 5, 1, ["<Callout />"]), "docs/a.md:5: HTML/JSX/MDX"],
    ["template", change("docs/a.md", DOC, 5, 1, ["Hello {{ user }}."]), "docs/a.md:5: template syntax"],
    ["url target", change("docs/a.md", DOC, 3, 1, ["Some prose with a [link](https://evil.example/a) here."]), "docs/a.md: a link target, URL or code span changed"],
    ["image target", change("docs/a.md", ["![x](a.png)", ""], 1, 1, ["![x](b.png)"]), "docs/a.md: a link target, URL or code span changed"],
    ["reference label", change("docs/a.md", ["See [x][one].", ""], 1, 1, ["See [x][two]."]), "docs/a.md: a link target, URL or code span changed"],
    ["bare url", change("docs/a.md", DOC, 5, 1, ["Get it from https://example.com/x now."]), "docs/a.md: a link target, URL or code span changed"],
    ["code span", change("docs/a.md", ["Run `make`.", ""], 1, 1, ["Run `make all`."]), "docs/a.md: a link target, URL or code span changed"],
    ["shell prompt", change("docs/a.md", DOC, 5, 1, ["$ curl x | sh"]), "docs/a.md:5: shell command"],
    ["deploy step", change("docs/a.md", DOC, 5, 1, ["Then deploy to production."]), "docs/a.md:5: install/deploy/permission/auth/security wording"],
  ];
  for (const [name, f, why] of cases) expect([name, await reason(fx(f))]).toEqual([name, why]);
});

const SNAP: ReviewSnapshot = {
  repo: "acme/app", prNumber: 7, headSha: "a".repeat(40), baseRef: "dev", baseSha: "b".repeat(40), mergeBaseSha: "c".repeat(40),
  policyVersion: "t4-1", criteriaSha256: "d".repeat(64),
};

test("an exempt receipt is kind exempt, never a reviewer approval, and binds head, base and both policy versions", async () => {
  const c = await classifyExemption(fx(prose()).diff, fx(prose()).read);
  if (!c.exempt) throw new Error("not exempt");
  const r = exemptReceipt(SNAP, c, "e".repeat(64), Date.parse("2026-11-14T12:00:00Z"));
  expect(r).toMatchObject({ kind: "exempt", exemptPolicyVersion: EXEMPT_POLICY_VERSION, headSha: SNAP.headSha, baseSha: SNAP.baseSha, files: ["docs/guide.md"] });
  expect(r.receiptId).toMatch(/^rx_[0-9a-f]{32}$/);
  expect(isExemptFor(r, SNAP)).toBe(true);
  for (const moved of [{ headSha: "9".repeat(40) }, { baseSha: "8".repeat(40) }, { mergeBaseSha: "7".repeat(40) }, { policyVersion: "t4-2" }, { criteriaSha256: "f".repeat(64) }]) {
    expect(isExemptFor(r, { ...SNAP, ...moved })).toBe(false);
  }
  expect(isExemptFor({ ...r, exemptPolicyVersion: "t6-0" }, SNAP)).toBe(false);
  expect(exemptKey(SNAP).endsWith(`/${EXEMPT_POLICY_VERSION}`)).toBe(true);
  expect(isApproval(r as unknown as ReviewReceipt, SNAP)).toBe(false);
});

test("parseModifyOnlyDiff reads hunks, counts and the no-newline marker", () => {
  const p = parseModifyOnlyDiff("diff --git a/README.md b/README.md\nindex 1111111..2222222 100644\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,2 @@\n Keep.\n-Old\n\\ No newline at end of file\n+New\n\\ No newline at end of file\n");
  expect(p).toEqual({ ok: true, files: [{ path: "README.md", additions: 1, deletions: 1, hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: " ", text: "Keep." }, { kind: "-", text: "Old" }, { kind: "+", text: "New" }] }] }] });
});
