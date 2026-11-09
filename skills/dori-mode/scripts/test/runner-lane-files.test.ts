import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readSync, readdirSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, checkFileBody, checkManagedReport, FILE_LIMITS, laneFilePaths, prepareInput, removeLaneTree, rewriteBrief, treeDigest, validateBriefFiles, validateFileKey, validateTree } from "../src/runner/lane-files.ts";
import type { LaneBriefFiles, LaneFileTree } from "../src/runner/protocol.ts";

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const run = { id: "00000000-0000-4000-8000-000000000001", requiredReport: false };
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const file = (path: string, data = Buffer.from([0, 255, 128, 1])) => ({ path, bytes: data.length, sha256: sha(data), base64: data.toString("base64") });
const empty = (): LaneBriefFiles => ({ run, tree: { directories: [], files: [] }, references: [] });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "runner-files-"));
  roots.push(dir);
  prepareInput(dir, "lane-a", "brief", empty(), false);
  return { dir, ...laneFilePaths(dir, "lane-a") };
};
const footer = '\n## Lane footer (written by dori launch)\nRewritten paths under briefs/<key>.files are read-only snapshots of lead files; do not edit them. Write every output to DORI_LANE_OUT, including updated versions of an attached file.\n\nWrite report files in DORI_LANE_OUT (POSIX: "$DORI_LANE_OUT"; PowerShell: "$env:DORI_LANE_OUT"). Finish writing before claiming done. dori ships that entire directory to the lead when you run claim-done or report done; files elsewhere are not collected. Keep each file at or below 262144 bytes and the directory at or below 393216 bytes total, with at most 64 files.\n';

test("extract binary and empty directories privately; rewrite only UTF-16 occurrence ranges and preserve footer and suffix", () => {
  const t = setup(), source = "/lead/research/x/notes.md";
  const brief = `update ${source}:12${footer}`;
  const files: LaneBriefFiles = { run, tree: { directories: ["r0000", "r0000/empty"], files: [file("r0000/notes.md")] },
    references: [{ start: 7, end: 7 + source.length, target: "r0000/notes.md" }] };
  prepareInput(t.dir, "lane-a", brief, files, false);
  expect(readFileSync(join(t.input, "r0000/notes.md"))).toEqual(Buffer.from([0, 255, 128, 1]));
  expect(readdirSync(join(t.input, "r0000/empty"))).toEqual([]);
  expect(readFileSync(join(t.dir, "briefs/lane-a.md"), "utf8")).toBe(`update ${join(t.input, "r0000/notes.md")}:12${footer}`);
  expect(brief).toBe(`update ${source}:12${footer}`);
  expect(lstatSync(t.input).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(t.input, "r0000/notes.md")).mode & 0o777).toBe(0o600);
  const unicode = `😀 "${source}" ${source}b ${source}:9`;
  const refs = { ...files, references: [{ start: 4, end: 4 + source.length, target: "r0000/notes.md" }] };
  validateBriefFiles("lane-a", unicode, refs);
  expect(rewriteBrief(unicode, refs, t.input)).toBe(`😀 "${join(t.input, "r0000/notes.md")}" ${source}b ${source}:9`);
  expect(rewriteBrief(unicode, refs, "C:\\runner\\briefs\\lane-a.files", true)).toBe(`😀 "C:\\runner\\briefs\\lane-a.files\\r0000\\notes.md" ${source}b ${source}:9`);
});

test("snapshot binary, zero-byte and empty directories in raw byte order with stable digest", () => {
  const t = setup();
  mkdirSync(join(t.output, "empty"), { mode: 0o700 });
  writeFileSync(join(t.output, "z"), Buffer.from([255, 0, 128]));
  writeFileSync(join(t.output, "A"), "");
  const tree = captureOutput(t.dir, "lane-a", run);
  expect(tree.directories).toEqual(["empty"]);
  expect(tree.files.map((f) => f.path)).toEqual(["A", "z"]);
  expect(tree.files[0]?.bytes).toBe(0);
  expect(Buffer.from(tree.files[1]!.base64, "base64")).toEqual(Buffer.from([255, 0, 128]));
  expect(treeDigest(tree)).toBe(sha(Buffer.from(JSON.stringify([["empty"], [["A", 0, sha(Buffer.alloc(0))], ["z", 3, sha(Buffer.from([255, 0, 128]))]]]))));
});

for (const name of ["../x", "/x", "C:/x", "\\\\server\\x", "a\\b", ".", "", "a.", "a ", "CON", "com¹.txt", "NUL.txt", "LPT9", "a:b", "a?b", "a\u0000b", "e\u0301", ".dori-lane-files.json"]) {
  test(`refuse unsafe manifest path ${JSON.stringify(name)}`, () => {
    expect(() => validateTree("lane-a", { directories: [], files: [file(name)] })).toThrow("LANE_FILES_INVALID");
  });
}
for (const key of ["../x", "CON", "LPT¹", "bad.", "", "a/b"]) test(`refuse unsafe managed key ${JSON.stringify(key)}`, () => {
  expect(() => validateFileKey(key)).toThrow("LANE_FILES_INVALID");
});
test("refuse unsorted, case collisions, absent parents, directory-file collisions and altered encodings", () => {
  for (const [tree, reason] of [
    [{ directories: [], files: [file("z"), file("a")] }, "tree-order"],
    [{ directories: [], files: [file("A"), file("a")] }, "duplicate-path"],
    [{ directories: [], files: [file("a/b")] }, "missing-parent"],
    [{ directories: ["a"], files: [file("a")] }, "file-directory-collision"],
    [{ directories: [], files: [{ ...file("a"), base64: "/w" }] }, "base64"],
    [{ directories: [], files: [{ ...file("a"), bytes: 3 }] }, "byte-count"],
    [{ directories: [], files: [{ ...file("a"), sha256: "0".repeat(64) }] }, "digest"],
  ] as const) expect(() => validateTree("lane-a", tree)).toThrow(`(${reason})`);
});
test("reference validation rejects overlap, bounds, invalid targets and run IDs", () => {
  const files = { ...empty(), tree: { directories: [], files: [file("a")] } };
  for (const references of [[{ start: 0, end: 5, target: "a" }], [{ start: 0, end: 1, target: "missing" }],
    [{ start: 0, end: 2, target: "a" }, { start: 1, end: 3, target: "a" }]]) {
    expect(() => validateBriefFiles("lane-a", "abc", { ...files, references })).toThrow("LANE_FILES_INVALID");
  }
  expect(() => validateBriefFiles("lane-a", "", { ...files, run: { ...run, id: "UPPER" } })).toThrow("(run-id)");
});
test("all byte and count limits admit equality and refuse the next item", () => {
  const tree: LaneFileTree = { directories: [], files: [file("a", Buffer.alloc(FILE_LIMITS.fileBytes)), file("b", Buffer.alloc(FILE_LIMITS.totalBytes - FILE_LIMITS.fileBytes))] };
  validateTree("lane-a", tree);
  expect(() => validateTree("lane-a", { ...tree, files: [file("a", Buffer.alloc(FILE_LIMITS.fileBytes + 1))] })).toThrow("LANE_FILE_TOO_LARGE");
  expect(() => validateTree("lane-a", { ...tree, files: [...tree.files, file("c", Buffer.alloc(1))] })).toThrow("LANE_FILES_TOO_LARGE");
  for (const [count, name] of [[64, "files"], [128, "directories"]] as const) {
    const paths = Array.from({ length: count }, (_, i) => `p${String(i).padStart(3, "0")}`);
    const t = name === "files" ? { directories: [], files: paths.map((p) => file(p, Buffer.alloc(0))) } : { directories: paths, files: [] };
    validateTree("lane-a", t);
    expect(() => validateTree("lane-a", name === "files" ? { ...t, files: [...t.files, file("z")] } : { ...t, directories: [...t.directories, "z"] })).toThrow(`${name} is ${count + 1}`);
  }
  validateBriefFiles("lane-a", "x".repeat(65536), empty());
  expect(() => validateBriefFiles("lane-a", "x".repeat(65537), empty())).toThrow("briefBytes");
  const refs = Array.from({ length: 256 }, (_, i) => ({ start: i * 2, end: i * 2 + 1, target: "a" }));
  validateBriefFiles("lane-a", "x ".repeat(256), { ...empty(), tree: { directories: [], files: [file("a")] }, references: refs });
  expect(() => validateBriefFiles("lane-a", "x ".repeat(257), { ...empty(), references: [...refs, { start: 512, end: 513, target: "a" }] })).toThrow("references");
  const source = "x".repeat(4096);
  validateBriefFiles("lane-a", source, { ...empty(), tree: { directories: ["a"], files: [] }, references: [{ start: 0, end: 4096, target: "a" }] });
  expect(() => validateBriefFiles("lane-a", source + "x", { ...empty(), references: [{ start: 0, end: 4097, target: "a" }] })).toThrow("sourcePathBytes");
  const paths = Array.from({ length: 16 }, (_, i) => Array(i + 1).fill("a").join("/"));
  validateTree("lane-a", { directories: paths, files: [] });
  expect(() => validateTree("lane-a", { directories: [...paths, paths.at(-1) + "/a"], files: [] })).toThrow("depth");
  validateTree("lane-a", { directories: [], files: [file("a".repeat(120))] });
  expect(() => validateTree("lane-a", { directories: [], files: [file("a".repeat(121))] })).toThrow("componentBytes");
  const parent = "a".repeat(119), child = parent + "/" + "b".repeat(120);
  validateTree("lane-a", { directories: [parent], files: [file(child)] });
  expect(() => validateTree("lane-a", { directories: [parent + "a"], files: [file(parent + "a/" + "b".repeat(120))] })).toThrow("relativePathBytes");
  const body = { text: "" };
  body.text = "x".repeat(786432 - Buffer.byteLength(JSON.stringify(body)));
  checkFileBody("lane-a", body);
  expect(() => checkFileBody("lane-a", { text: body.text + "x" })).toThrow("LANE_FILES_FRAME_TOO_LARGE");
});
test("managed text/evidence are lossless at equality and refused above it; digest/revision/kind are checked", () => {
  const tree = empty().tree, files = { run, revision: 1, sha256: treeDigest(tree), tree };
  const body = { key: "lane-a", kind: "done" as const, text: "x".repeat(65536), evidence: "e".repeat(16384), files };
  checkManagedReport(body);
  expect(() => checkManagedReport({ ...body, text: body.text + "x" })).toThrow("reportTextBytes");
  expect(() => checkManagedReport({ ...body, evidence: body.evidence + "x" })).toThrow("evidenceBytes");
  expect(() => checkManagedReport({ ...body, kind: "progress" })).toThrow("(report-kind)");
  expect(() => checkManagedReport({ ...body, files: { ...files, revision: 0 } })).toThrow("(revision)");
  expect(() => checkManagedReport({ ...body, files: { ...files, sha256: "0".repeat(64) } })).toThrow("(digest)");
});
test("capture refuses links and hard links, but cleanup unlinks invalid children without following them", () => {
  const t = setup(), outside = join(t.dir, "outside");
  writeFileSync(outside, "keep");
  symlinkSync(outside, join(t.output, "link"));
  expect(() => captureOutput(t.dir, "lane-a", run)).toThrow("(symlink)");
  removeLaneTree(t.dir, t.output);
  expect(readFileSync(outside, "utf8")).toBe("keep");
  mkdirSync(t.output, { mode: 0o700 });
  linkSync(outside, join(t.output, "hard"));
  expect(() => captureOutput(t.dir, "lane-a", run)).toThrow("(hard-link)");
});
test("injected growth, file replacement, and directory membership changes are refused with bounded reads", () => {
  const t = setup(), path = join(t.output, "a");
  writeFileSync(path, "one");
  let maxRead = 0;
  expect(() => captureOutput(t.dir, "lane-a", run, false, {
    read: (fd, buf, offset, length, position) => { maxRead = Math.max(maxRead, length); writeFileSync(path, "changed"); return readSync(fd, buf, offset, length, position); },
  })).toThrow("LANE_REPORT_CHANGED");
  expect(maxRead).toBeLessThanOrEqual(4);
  expect(() => captureOutput(t.dir, "lane-a", run, false, {
    stat: (fd) => ({ ...fstatSync(fd), ino: -1 }) as Stats,
  })).toThrow("LANE_REPORT_CHANGED");
  let reads = 0;
  expect(() => captureOutput(t.dir, "lane-a", run, false, {
    readdir: (p) => { const names = readdirSync(p); return ++reads > 1 ? [...names, "new"] : names; },
  })).toThrow("LANE_REPORT_CHANGED");
});
test("oversize stat refuses before opening and required empty counts regular zero-byte files", () => {
  const t = setup(), path = join(t.output, "a");
  writeFileSync(path, Buffer.alloc(262145));
  let opens = 0;
  expect(() => captureOutput(t.dir, "lane-a", run, false, { open: () => { opens++; throw new Error("must not open"); } })).toThrow("LANE_REPORT_TOO_LARGE");
  expect(opens).toBe(0);
  rmSync(path);
  mkdirSync(join(t.output, "empty"));
  expect(() => captureOutput(t.dir, "lane-a", { ...run, requiredReport: true })).toThrow("LANE_REPORT_REQUIRED");
  writeFileSync(path, "");
  expect(captureOutput(t.dir, "lane-a", { ...run, requiredReport: true }).files).toHaveLength(1);
});
test("Windows ACL reader refuses reparse points and foreign owners during capture", () => {
  const t = setup();
  writeFileSync(join(t.output, "a"), "");
  const sid = "S-1-5-21-1";
  const acl = (path: string) => ({ owner: sid, sddl: `O:${sid}D:P(A;;FA;;;${sid})`, ...(path.endsWith("/a") ? { reparseTag: 0xa000000c } : {}) });
  expect(() => captureOutput(t.dir, "lane-a", run, false, { acl, userSid: () => sid }, "win32")).toThrow("(reparse-point)");
  expect(() => captureOutput(t.dir, "lane-a", run, false, { acl: () => ({ owner: "S-1-5-21-2", sddl: "O:S-1-5-21-2D:P(A;;FA;;;S-1-5-21-2)" }), userSid: () => sid }, "win32")).toThrow("(owner-or-acl)");
});
test("failed manifest admission leaves previous inputs and brief untouched", () => {
  const t = setup();
  expect(() => prepareInput(t.dir, "lane-a", "bad", { ...empty(), tree: { directories: [], files: [file("../escape")] } }, false)).toThrow("LANE_FILES_INVALID");
  expect(readFileSync(join(t.dir, "briefs/lane-a.md"), "utf8")).toBe("brief");
  expect(existsSync(t.stage)).toBe(false);
  expect(readdirSync(t.input)).toEqual([]);
});
