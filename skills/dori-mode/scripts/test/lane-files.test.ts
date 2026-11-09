import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { briefDeliverable, prepareLeadLaneBrief } from "../src/launch.ts";
import { checkLaneFilesBody, checkLaneReportText, FILE_LIMITS, installLaneReports, LaneFileError, LEAD_ATTACHMENT_ROOTS, prepareLaneBrief, protectLaneCollectionDirectory, scanBriefPaths, treeDigest, validateLaneOutput, validateLaneTree, verifyLaneFileReceipt, writeLaneAttachmentPin } from "../src/lane-files.ts";
import { StateLockError, tryStateLock } from "../src/state-lock.ts";
import type { Lane } from "../src/registry.ts";
import type { LaneFile, LaneOutputFiles } from "../src/runner/protocol.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
const run = { id: "00000000-0000-4000-8000-000000000001", requiredReport: false };
const file = (path: string, data: Buffer | string = "report"): LaneFile => {
  const b = Buffer.from(data);
  return { path, bytes: b.length, base64: b.toString("base64"), sha256: createHash("sha256").update(b).digest("hex") };
};
const output = (files = [file("report.md")], revision = 1, directories: string[] = []): LaneOutputFiles => {
  const tree = { directories, files };
  return { run, revision, tree, sha256: treeDigest(tree) };
};
const fixture = () => {
  const s = withState(); cleanup.push(s.done);
  const stateDir = join(s.dir, "state"), research = join(s.dir, "research");
  mkdirSync(stateDir, { mode: 0o700 }); mkdirSync(research, { mode: 0o700 });
  const lane: Lane = { key: "lane-a", title: "a", thread: "none", brief: join(stateDir, "brief.md"), done: 'command ["true"]', openedAt: "2026-11-09T00:00:00Z", fileRun: run };
  const notes = new Map<string, string>();
  const options = { now: () => Date.parse("2026-11-09T05:54:37Z"), checkCurrent: async () => lane,
    emit: (id: string, line: string) => { notes.set(id, line); } };
  return { ...s, stateDir, research, lane, notes, options, target: join(research, lane.key) };
};

test("scanner pins delimiters, spaces, citations, UTF-16 and foreign/URI exclusions", () => {
  const text = '😀 /a:12 /ab#L2-L4, "/space path:4" `/back tick#L3` </angle space> (/p) [/b] {/c}; x=/d x: /e https://host/no file:/url C:\\foreign \\\\server\\share ~/no $HOME/no relative/no';
  const found = scanBriefPaths(text, "linux");
  expect(found.map((x) => x.path)).toEqual(["/a", "/ab", "/space path", "/back tick", "/angle space", "/p", "/b", "/c", "/d", "/e"]);
  for (const x of found) expect(text.slice(x.start, x.end)).toBe(x.path);
  expect(found[0]!.start).toBe(3);
  expect(scanBriefPaths("C:\\a:12 C:/b#L3 /foreign //server/share", "win32").map((x) => x.path)).toEqual(["C:\\a", "C:/b"]);
  expect(scanBriefPaths('/yes\n## Lane footer (written by dori launch)\n/no')).toEqual([{ path: "/yes", start: 0, end: 4 }]);
  expect(scanBriefPaths("(/x), /y.!? '/z.!?'")).toHaveLength(3);
  expect(scanBriefPaths('https://host?q="/inside" file:"/also-inside" (https://host< /no >)')).toEqual([]);
  for (const delimiter of ["", " ", "\n", "(", "[", "{", "=", ": "]) {
    expect(scanBriefPaths(`${delimiter}/a:12:9;`)).toEqual([{ start: delimiter.length, end: delimiter.length + 2, path: "/a" }]);
  }
});

test("word apostrophes and non-path quote/code spans do not hide in-root paths", () => {
  const p = "/data/dori/research/k/a.md";
  for (const text of [`Don't skip ${p} and don't forget.`, `Run \`cat ${p}\` first.`, `the lane's notes are in ${p}, it's fine`, `See ${p}`]) {
    const found = scanBriefPaths(text, "linux");
    expect(found.map((x) => x.path)).toEqual([p]);
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe(p);
  }
  expect(scanBriefPaths(`"a" "/p q" 'x ${p}'`, "linux").map((x) => x.path)).toEqual(["/p q", p]);
});

test("only a deliverable: report line declares a report; any other deliverable line is ordinary brief text", () => {
  expect(briefDeliverable("none")).toBe(false);
  expect(briefDeliverable("- `deliverable: RePoRt`\ndeliverable: other")).toBe(true);
  for (const line of ["deliverable:", "- Deliverable:", "Deliverable: PR", "deliverable: reports"]) expect(briefDeliverable(line)).toBe(false);
});

const notAttached = (path: string): string => `LANE_FILE_NOT_SHIPPED lane-a: ${JSON.stringify(path)} was not attached at launch and stays literal`;

test("recovery ships only what the launch pinned, whatever the lane later writes into its own brief", async () => {
  const f = fixture(), deps = depsFor(newWorld(), fakeClock(0), f.stateDir);
  const mine = join(f.research, "mine"), other = join(f.research, "other");
  mkdirSync(mine); mkdirSync(other);
  writeFileSync(join(mine, "a.md"), "mine"); writeFileSync(join(other, "secret.md"), "secret");
  writeFileSync(f.lane.brief, `read ${join(mine, "a.md")}`);
  const launched = await prepareLeadLaneBrief(deps, f.lane, run.id);
  expect(launched.sources).toEqual([realpathSync(join(mine, "a.md"))]);
  writeLaneAttachmentPin(f.stateDir, f.lane.key, launched.sources);
  // stateDir is read-write inside a local sandbox: the lane names another lane's research and the whole root.
  writeFileSync(f.lane.brief, `read ${join(mine, "a.md")} and ${join(other, "secret.md")} and ${f.research}`);
  const recovered = await prepareLeadLaneBrief(deps, f.lane, run.id, true);
  expect(recovered.files.tree.files).toEqual([file("r0000/a.md", "mine")]);
  expect(recovered.notes).toEqual([notAttached(join(other, "secret.md")), notAttached(f.research)]);
});

test("a lane with no launch pin recovers without attachments and without re-reading its declarations", async () => {
  const f = fixture(), deps = depsFor(newWorld(), fakeClock(0), f.stateDir), briefs = join(f.stateDir, "briefs");
  mkdirSync(briefs); writeFileSync(join(briefs, "big"), Buffer.alloc(FILE_LIMITS.fileBytes + 1)); symlinkSync("/etc", join(briefs, "link"));
  writeFileSync(f.lane.brief, `see ${briefs}\n- Deliverable:\ndeliverable: report`);
  const legacy = await prepareLeadLaneBrief(deps, { ...f.lane, fileRun: undefined }, run.id, true);
  expect(legacy.files.tree).toEqual({ directories: [], files: [] });
  expect(legacy.files.run.requiredReport).toBe(false);
  expect(legacy.notes).toEqual([notAttached(briefs)]);
  expect((await prepareLeadLaneBrief(deps, { ...f.lane, fileRun: { ...run, requiredReport: true } }, run.id, true)).files.run.requiredReport).toBe(true);
});

test("pinned attachments that outgrew the caps relaunch the lane without them, while a fresh launch still refuses", async () => {
  const f = fixture(), deps = depsFor(newWorld(), fakeClock(0), f.stateDir), data = join(f.research, "data.md");
  writeFileSync(data, "small"); writeFileSync(f.lane.brief, `use ${data}`);
  writeLaneAttachmentPin(f.stateDir, f.lane.key, [realpathSync(data)]);
  writeFileSync(data, Buffer.alloc(FILE_LIMITS.fileBytes + 1));
  const recovered = await prepareLeadLaneBrief(deps, f.lane, run.id, true);
  expect(recovered.files.tree).toEqual({ directories: [], files: [] });
  expect(recovered.notes[0]).toStartWith("LANE_FILES_SKIPPED lane-a: relaunched without attachments (LANE_FILE_TOO_LARGE lane-a:");
  expect(recovered.notes.slice(1)).toEqual([notAttached(data)]);
  await expect(prepareLeadLaneBrief(deps, f.lane, run.id)).rejects.toThrow("LANE_FILE_TOO_LARGE");
});

test("preparation ships binary and empty directories, deduplicates overlapping references, and preserves lead spelling", () => {
  const f = fixture(), dir = join(f.research, "x"), notes = join(dir, "notes.md");
  mkdirSync(dir); mkdirSync(join(dir, "empty")); writeFileSync(notes, Buffer.from([0, 255, 10]));
  const body = `update ${notes}:12\n"${dir}"\n${notes}`;
  const p = prepareLaneBrief({ key: f.lane.key, stateDir: f.stateDir, briefText: body, requiredReport: false, runId: run.id });
  expect(p.files.tree.directories).toEqual(["r0000", "r0000/x", "r0000/x/empty"]);
  expect(p.files.tree.files).toEqual([file("r0000/x/notes.md", Buffer.from([0, 255, 10]))]);
  expect(p.files.references.map((r) => r.target)).toEqual(["r0000/x/notes.md", "r0000/x", "r0000/x/notes.md"]);
  expect(body.slice(p.files.references[0]!.start, p.files.references[0]!.end)).toBe(notes);
  expect(body.slice(p.files.references[0]!.end)).toStartWith(":12");
});

test("outside-root references remain literal, have one metadata-only note, and missing paths have none", () => {
  const f = fixture(), outside = join(f.dir, "repo");
  mkdirSync(outside); writeFileSync(join(outside, "huge"), Buffer.alloc(FILE_LIMITS.fileBytes + 1));
  let reads = 0;
  const briefText = `${outside} ${outside} ${join(f.dir, "missing")}`;
  const prepared = prepareLaneBrief({ key: f.lane.key, stateDir: f.stateDir, briefText, requiredReport: false,
    readers: { readdir: () => { reads++; throw new Error("outside enumeration"); }, read: () => { reads++; throw new Error("outside read"); } } });
  expect(reads).toBe(0);
  expect(prepared.files.tree).toEqual({ directories: [], files: [] });
  expect(prepared.files.references).toEqual([]);
  expect(prepared.notes).toEqual([`LANE_FILE_NOT_SHIPPED lane-a: ${JSON.stringify(outside)} is outside the attachment roots and stays literal`]);
  const boundary = join(f.dir, "research-other"); mkdirSync(boundary);
  expect(prepareLaneBrief({ key: f.lane.key, stateDir: f.stateDir, briefText: boundary, requiredReport: false }).files.tree.files).toEqual([]);
  const outsideFile = join(f.dir, "file"); writeFileSync(outsideFile, "not read");
  expect(prepareLaneBrief({ key: f.lane.key, stateDir: f.stateDir, briefText: `${outsideFile} ${outsideFile}`, requiredReport: false,
    readers: { read: () => { throw new Error("outside file opened"); } },
  }).notes).toEqual([`LANE_FILE_NOT_SHIPPED lane-a: ${JSON.stringify(outsideFile)} is outside the attachment roots and stays literal`]);
});

test("in-root escaping/dangling links and hard links refuse before reading", () => {
  const f = fixture(), outside = join(f.dir, "outside"), source = join(f.research, "link");
  writeFileSync(outside, "secret"); symlinkSync(outside, source);
  const prepare = () => prepareLaneBrief({ key: f.lane.key, stateDir: f.stateDir, briefText: source, requiredReport: false });
  expect(prepare).toThrow("(symlink)");
  rmSync(source); symlinkSync(join(f.dir, "missing"), source); expect(prepare).toThrow("(symlink)");
  rmSync(source); linkSync(outside, source); expect(prepare).toThrow("(hard-link)");
});

test("bounded readers deterministically detect mutation and enforce exact file/total limits", () => {
  const f = fixture(), source = join(f.research, "data");
  writeFileSync(source, Buffer.alloc(FILE_LIMITS.fileBytes));
  const prepare = (read?: (path: string, n: number) => Buffer) => prepareLaneBrief({ key: f.lane.key, stateDir: f.stateDir, briefText: source, requiredReport: false, ...(read ? { readers: { read } } : {}) });
  expect(prepare().files.tree.files[0]!.bytes).toBe(FILE_LIMITS.fileBytes);
  expect(() => prepare(() => Buffer.alloc(0))).toThrow("LANE_FILE_CHANGED");
  // Diagnostics name the attachment that failed, not the first group.
  const second = join(f.research, "second"); writeFileSync(second, "two");
  const real = realpathSync(second);
  const two = (read: (path: string, n: number) => Buffer) => prepareLaneBrief({ key: f.lane.key, stateDir: f.stateDir, briefText: `${source} ${second}`, requiredReport: false, readers: { read } });
  expect(() => two((path, n) => path === real ? Buffer.alloc(0) : readFileSync(path).subarray(0, n)))
    .toThrow(`LANE_FILE_CHANGED lane-a: attachment ${JSON.stringify(real)} changed while being read; finish writing it and launch again`);
  expect(() => two((path, n) => { if (path === real) throw new Error("EIO"); return readFileSync(path).subarray(0, n); }))
    .toThrow(`LANE_FILE_READ_FAILED lane-a: cannot read attachment ${JSON.stringify(real)}; make it readable or remove its reference and launch again`);
  writeFileSync(source, Buffer.alloc(FILE_LIMITS.fileBytes + 1)); expect(prepare).toThrow("LANE_FILE_TOO_LARGE");
  validateLaneTree("lane-a", { directories: [], files: [file("a", Buffer.alloc(FILE_LIMITS.fileBytes)), file("b", Buffer.alloc(FILE_LIMITS.totalBytes - FILE_LIMITS.fileBytes))] });
  expect(() => validateLaneTree("lane-a", { directories: [], files: [file("a", Buffer.alloc(FILE_LIMITS.fileBytes)), file("b", Buffer.alloc(FILE_LIMITS.totalBytes - FILE_LIMITS.fileBytes + 1))] })).toThrow("LANE_FILES_TOO_LARGE");
});

test("portable manifest validation rejects names, collision, order, parents, base64, lengths and digests", () => {
  for (const path of ["../x", "/absolute", "C:/drive", "a\\b", "CON.txt", "COM¹", "a.", "a ", "e\u0301", ".dori-lane-files.json"]) {
    expect(() => validateLaneTree("lane-a", { directories: [], files: [file(path)] })).toThrow();
  }
  const bad = [
    { directories: [], files: [file("a"), file("A")] },
    { directories: [], files: [file("b"), file("a")] },
    { directories: [], files: [file("dir/a")] },
    { directories: ["a"], files: [file("a")] },
    { directories: [], files: [{ ...file("a"), base64: "cg" }] },
    { directories: [], files: [{ ...file("a"), bytes: 0 }] },
    { directories: [], files: [{ ...file("a"), sha256: "0".repeat(64) }] },
  ];
  for (const tree of bad) expect(() => validateLaneTree("lane-a", tree)).toThrow();
  for (const n of [64, 65]) {
    const tree = { directories: [], files: Array.from({ length: n }, (_, i) => file(`f${String(i).padStart(3, "0")}`, "")) };
    if (n === 64) validateLaneTree("lane-a", tree); else expect(() => validateLaneTree("lane-a", tree)).toThrow("files is 65");
  }
  expect(() => validateLaneOutput("lane-a", { ...output(), revision: 0 }, run)).toThrow("(revision)");
  expect(() => validateLaneOutput("lane-a", { ...output(), run: { ...run, requiredReport: true } }, run)).toThrow("(run-requirement)");
});

test("research destination derives from both custom and default state roots", () => {
  expect(LEAD_ATTACHMENT_ROOTS("/home/test/.dori/state")).toEqual(["/home/test/.dori/research", "/home/test/.dori/state/briefs"]);
  expect(LEAD_ATTACHMENT_ROOTS("/data/dori/state")).toEqual(["/data/dori/research", "/data/dori/state/briefs"]);
});

test("installation preserves binary identity and replaces entire tree with monotonic same-run receipts", async () => {
  const f = fixture(), first = output([file("a", Buffer.from([0, 255])), file("b", "")]);
  const receipt = await installLaneReports(f.stateDir, f.lane.key, first, f.options);
  expect(readFileSync(join(f.target, "a"))).toEqual(Buffer.from([0, 255]));
  expect(lstatSync(join(f.target, "a")).mode & 0o777).toBe(0o600);
  await installLaneReports(f.stateDir, f.lane.key, output([file("c")], 2), f.options);
  expect(readdirSync(f.target).sort()).toEqual([".dori-lane-files.json", "c"]);
  await installLaneReports(f.stateDir, f.lane.key, first, f.options);
  expect(existsSync(join(f.target, "c"))).toBe(true);
  await verifyLaneFileReceipt(f.stateDir, f.lane.key, receipt, f.options);
  expect(() => validateLaneOutput(f.lane.key, { ...first, run: { ...run, id: "00000000-0000-4000-8000-000000000002" } }, run)).toThrow("LANE_REPORT_STALE");
  await expect(installLaneReports(f.stateDir, f.lane.key, output([file("different")], 2), f.options)).rejects.toThrow("(digest)");
  writeFileSync(join(f.target, "c"), "modified");
  await expect(verifyLaneFileReceipt(f.stateDir, f.lane.key, receipt, f.options)).rejects.toThrow("LANE_REPORT_RECEIPT_MISSING");
});

for (const kind of ["nonempty", "empty", "invalid receipt"]) test(`unmanaged ${kind} destination migrates once and preserves every byte`, async () => {
  const f = fixture(); mkdirSync(f.target);
  if (kind === "nonempty") { writeFileSync(join(f.target, "prior"), "old"); symlinkSync("/missing-target", join(f.target, "unfollowed")); }
  if (kind === "invalid receipt") writeFileSync(join(f.target, ".dori-lane-files.json"), "invalid");
  await installLaneReports(f.stateDir, f.lane.key, output(), f.options);
  const backup = `${f.target}.pre-dori-20261109T055437Z`;
  expect(existsSync(backup)).toBe(true);
  if (kind === "nonempty") { expect(readFileSync(join(backup, "prior"), "utf8")).toBe("old"); expect(lstatSync(join(backup, "unfollowed")).isSymbolicLink()).toBe(true); }
  expect([...f.notes]).toEqual([[`lane-report-migrated:lane-a:20261109T055437Z`, `LANE_REPORT_MIGRATED lane-a: moved unmanaged collection directory ${JSON.stringify(f.target)} to ${JSON.stringify(backup)}; preserved its contents and installing the report snapshot`]]);
  await installLaneReports(f.stateDir, f.lane.key, output(), f.options);
  expect(readdirSync(f.research).filter((x) => x.includes(".pre-dori-"))).toHaveLength(1);
  expect(f.notes.size).toBe(1);
});

test("migration timestamp collisions advance the injected time without waiting", async () => {
  const f = fixture(); mkdirSync(f.target); mkdirSync(`${f.target}.pre-dori-20261109T055437Z`);
  writeFileSync(join(`${f.target}.pre-dori-20261109T055437Z`, "keep"), "keep");
  await installLaneReports(f.stateDir, f.lane.key, output(), f.options);
  expect(existsSync(`${f.target}.pre-dori-20261109T055438Z`)).toBe(true);
  expect(readFileSync(join(`${f.target}.pre-dori-20261109T055437Z`, "keep"), "utf8")).toBe("keep");
});

for (const point of ["staged", "intent-written", "before-migration-rename", "migration-renamed", "note-persisted", "note-emitted", "note-delivered", "before-snapshot-rename", "snapshot-renamed", "completed"]) test(`migration resumes after ${point} without losing the backup`, async () => {
  const f = fixture(); mkdirSync(f.target); writeFileSync(join(f.target, "prior"), "old");
  let failed = false;
  await expect(installLaneReports(f.stateDir, f.lane.key, output(), { ...f.options, step: (name) => { if (!failed && name === point) { failed = true; throw new Error("injected crash"); } } })).rejects.toThrow();
  expect(failed).toBe(true);
  await installLaneReports(f.stateDir, f.lane.key, output(), f.options);
  expect(readFileSync(join(`${f.target}.pre-dori-20261109T055437Z`, "prior"), "utf8")).toBe("old");
  expect(readFileSync(join(f.target, "report.md"), "utf8")).toBe("report");
  expect(readdirSync(f.research).filter((x) => x.includes(".pre-dori-"))).toHaveLength(1);
  expect(f.notes.size).toBe(1);
});

for (const point of ["staged", "intent-written", "previous-renamed", "before-snapshot-rename", "snapshot-renamed", "completed"]) test(`managed replacement resumes after ${point}`, async () => {
  const f = fixture(); await installLaneReports(f.stateDir, f.lane.key, output(), f.options);
  let failed = false;
  const replacement = output([file("new", "replacement")], 2);
  await expect(installLaneReports(f.stateDir, f.lane.key, replacement, { ...f.options, step: (s) => { if (!failed && s === point) { failed = true; throw new Error("crash"); } } })).rejects.toThrow();
  await installLaneReports(f.stateDir, f.lane.key, replacement, f.options);
  expect(readFileSync(join(f.target, "new"), "utf8")).toBe("replacement");
  expect(existsSync(join(f.target, "report.md"))).toBe(false);
});

test("unsafe destination and ancestry links are permanent and active-run fencing writes nothing", async () => {
  const f = fixture(); symlinkSync(f.stateDir, f.target);
  await expect(installLaneReports(f.stateDir, f.lane.key, output(), f.options)).rejects.toThrow("LANE_REPORT_DESTINATION_UNSAFE");
  rmSync(f.target);
  await expect(installLaneReports(f.stateDir, f.lane.key, output(), { ...f.options, checkCurrent: async () => ({ ...f.lane, closedAt: "closed" }) })).rejects.toThrow("LANE_REPORT_STALE");
  expect(existsSync(f.target)).toBe(false);
});

test("a held per-key lock is transient contention and unexpected failures are not relabeled unsafe", async () => {
  const f = fixture();
  const held = await installLaneReports(f.stateDir, f.lane.key, output(), { ...f.options, lock: async (path) => { throw new StateLockError(`state lock timed out: ${path}`); } })
    .then(() => undefined, (e: unknown) => e);
  expect(held).toBeInstanceOf(LaneFileError);
  expect((held as LaneFileError).code).toBe("LANE_REPORT_COLLECT_FAILED");
  expect((held as LaneFileError).transient).toBe(true);
  expect((held as LaneFileError).message).toBe(`LANE_REPORT_COLLECT_FAILED lane-a: cannot install report files in ${JSON.stringify(f.target)}; fix lead disk space and permissions; the saved report will retry`);
  expect(existsSync(f.target)).toBe(false);
  const boom = new Error("boom");
  await expect(installLaneReports(f.stateDir, f.lane.key, output(), { ...f.options, lock: async () => { throw boom; } })).rejects.toBe(boom);
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  await expect(installLaneReports(f.stateDir, f.lane.key, output(), { ...f.options, lock: async () => { throw denied; } })).rejects.toThrow("LANE_REPORT_DESTINATION_UNSAFE");
  await installLaneReports(f.stateDir, f.lane.key, output(), f.options);
  expect(readFileSync(join(f.target, "report.md"), "utf8")).toBe("report");
});

test("lead footer regeneration keeps both shared sentences once and scans only the user body", async () => {
  const f = fixture(), w = newWorld(), deps = depsFor(w, fakeClock(0), f.stateDir);
  writeFileSync(f.lane.brief, "deliverable: report\nbody");
  const first = await prepareLeadLaneBrief(deps, f.lane, run.id);
  writeFileSync(f.lane.brief, first.briefText);
  const second = await prepareLeadLaneBrief(deps, f.lane, run.id);
  expect(second.briefText).toBe(first.briefText);
  expect(second.files.references).toEqual([]);
  expect(second.briefText.match(/Rewritten paths under briefs\/<key>.files/g)).toHaveLength(1);
  expect(second.briefText).toContain('Write report files in DORI_LANE_OUT (POSIX: "$DORI_LANE_OUT"; PowerShell: "$env:DORI_LANE_OUT"). Finish writing before claiming done.');
  expect(second.briefText).toContain("This lane declares deliverable: report.");
});

test("every manifest count, path and text boundary accepts equality and refuses one above", () => {
  const tree = (directories: string[], files: LaneFile[] = []) => ({ directories, files });
  for (const n of [128, 129]) {
    const dirs = Array.from({ length: n }, (_, i) => `d${String(i).padStart(3, "0")}`);
    if (n === 128) validateLaneTree("lane-a", tree(dirs));
    else expect(() => validateLaneTree("lane-a", tree(dirs))).toThrow("directories is 129");
  }
  for (const depth of [16, 17]) {
    const dirs = Array.from({ length: depth - 1 }, (_, i) => Array(i + 1).fill("a").join("/"));
    const t = tree(dirs, [file(Array(depth).fill("a").join("/"), "")]);
    if (depth === 16) validateLaneTree("lane-a", t);
    else expect(() => validateLaneTree("lane-a", t)).toThrow("depth is 17");
  }
  for (const n of [120, 121]) {
    const t = tree([], [file("é".repeat(60) + (n === 121 ? "a" : ""), "")]);
    if (n === 120) validateLaneTree("lane-a", t);
    else expect(() => validateLaneTree("lane-a", t)).toThrow("componentBytes is 121");
  }
  const parent = "a".repeat(120);
  validateLaneTree("lane-a", tree([parent], [file(`${parent}/${"b".repeat(119)}`, "")]));
  expect(() => validateLaneTree("lane-a", tree([parent], [file(`${parent}/${"b".repeat(120)}`, "")]))).toThrow("relativePathBytes is 241");
  checkLaneReportText("lane-a", "é".repeat(32768), "x".repeat(16384));
  expect(() => checkLaneReportText("lane-a", "x".repeat(65537))).toThrow("reportTextBytes is 65537");
  expect(() => checkLaneReportText("lane-a", "", "x".repeat(16385))).toThrow("evidenceBytes is 16385");
  checkLaneFilesBody("lane-a", "x".repeat(786430));
  expect(() => checkLaneFilesBody("lane-a", "x".repeat(786431))).toThrow("786433");
});

test("raw brief, references, and source spelling limits are measured before footer and filesystem reads", () => {
  const f = fixture(), source = join(f.research, "a"); writeFileSync(source, "");
  const prepare = (briefText: string) => prepareLaneBrief({ key: f.lane.key, stateDir: f.stateDir, briefText, requiredReport: false, runId: run.id });
  expect(prepare("x".repeat(65536)).files.references).toEqual([]);
  expect(() => prepare("x".repeat(65537))).toThrow("briefBytes is 65537");
  expect(prepare(Array(256).fill(source).join(" ")).files.references).toHaveLength(256);
  expect(() => prepare(Array(257).fill(source).join(" "))).toThrow("references is 257");
  const path = f.research + "/" + "x".repeat(4096 - f.research.length - 1);
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  const options = { key: f.lane.key, stateDir: f.stateDir, requiredReport: false, readers: { lstat: () => { throw missing; } } };
  expect(prepareLaneBrief({ ...options, briefText: path }).files.references).toEqual([]);
  expect(() => prepareLaneBrief({ ...options, briefText: path + "x" })).toThrow("sourcePathBytes is 4097");
});

test("required report checks recorded requirements and counts zero-byte regular files", () => {
  const required = { ...run, requiredReport: true };
  for (const tree of [{ directories: [], files: [] }, { directories: ["empty"], files: [] }]) {
    expect(() => validateLaneOutput("lane-a", { run: required, revision: 1, tree, sha256: treeDigest(tree) }, required))
      .toThrow("LANE_FILES_INVALID lane-a: invalid file payload (run-requirement); regenerate the brief or report and retry");
  }
  validateLaneOutput("lane-a", { ...output([file("zero", "")]), run: required }, required);
});

for (const migration of [false, true]) for (const point of ["intent-written", "before-snapshot-rename", "snapshot-renamed", "completed"]) {
  test(`receipt verification resumes ${migration ? "migration" : "replacement"} at ${point} and holds the lock through admission`, async () => {
    const f = fixture();
    if (migration) { mkdirSync(f.target); writeFileSync(join(f.target, "old"), "old"); }
    else await installLaneReports(f.stateDir, f.lane.key, output(), f.options);
    const next = output([file("new")], 2);
    await expect(installLaneReports(f.stateDir, f.lane.key, next, { ...f.options, step: (s) => { if (s === point) throw new Error("crash"); } })).rejects.toThrow();
    let admitted = false;
    await verifyLaneFileReceipt(f.stateDir, f.lane.key, next, f.options, async () => {
      admitted = true;
      expect(tryStateLock(join(f.stateDir, "lane-files", `${f.lane.key}.lock.sqlite`))).toBeUndefined();
      expect(readFileSync(join(f.target, "new"), "utf8")).toBe("report");
    });
    expect(admitted).toBe(true);
  });
}

test("migration records delivery separately and retries only an undelivered stable note", async () => {
  const f = fixture(); mkdirSync(f.target);
  const ids: string[] = [];
  const options = { ...f.options, emit: (id: string) => { ids.push(id); } };
  await expect(installLaneReports(f.stateDir, f.lane.key, output(), { ...options,
    step: (s) => { if (s === "note-persisted") throw new Error("crash before delivery"); },
  })).rejects.toThrow();
  expect(ids).toEqual([]);
  await installLaneReports(f.stateDir, f.lane.key, output(), options);
  await installLaneReports(f.stateDir, f.lane.key, output(), options);
  expect(ids).toEqual(["lane-report-migrated:lane-a:20261109T055437Z"]);
});

test("missing staged managed tree restores previous, and missing staged migration rebuilds without touching backup", async () => {
  for (const migration of [false, true]) {
    const f = fixture();
    if (migration) { mkdirSync(f.target); writeFileSync(join(f.target, "old"), "preserved"); }
    else await installLaneReports(f.stateDir, f.lane.key, output(), f.options);
    const next = output([file("new")], 2);
    await expect(installLaneReports(f.stateDir, f.lane.key, next, { ...f.options, step: (s) => {
      if (s === (migration ? "migration-renamed" : "previous-renamed")) throw new Error("crash");
    } })).rejects.toThrow();
    rmSync(join(f.research, ".dori-lane-files", f.lane.key, "next"), { recursive: true });
    await installLaneReports(f.stateDir, f.lane.key, next, f.options);
    expect(readFileSync(join(f.target, "new"), "utf8")).toBe("report");
    if (migration) expect(readFileSync(join(`${f.target}.pre-dori-20261109T055437Z`, "old"), "utf8")).toBe("preserved");
  }
});

test("raw brief equality remains valid after footer regeneration and does not charge generated rules", async () => {
  const f = fixture(), deps = depsFor(newWorld(), fakeClock(0), f.stateDir);
  writeFileSync(f.lane.brief, "x".repeat(65536));
  const first = await prepareLeadLaneBrief(deps, f.lane, run.id);
  expect(Buffer.byteLength(first.briefText)).toBeGreaterThan(65536);
  writeFileSync(f.lane.brief, first.briefText);
  expect((await prepareLeadLaneBrief(deps, f.lane, run.id)).briefText).toBe(first.briefText);
});

test("Windows creation protects the private directory with inheritable owner-only ACLs", () => {
  const calls: [string, readonly string[]][] = [];
  const run = (exe: string, args: readonly string[]) => { calls.push([exe, args]); };
  protectLaneCollectionDirectory("C:\\collection", { platform: "win32", sid: () => "S-1-5-21-42", run });
  expect(calls).toEqual([["icacls.exe", ["C:\\collection", "/inheritance:r", "/grant:r", "*S-1-5-21-42:(OI)(CI)F"]]]);
  protectLaneCollectionDirectory("/collection", { platform: "linux", run });
  expect(calls).toHaveLength(1);
});

test.each(["reparse-point", "owner-or-acl"] as const)("input security readers refuse %s before opening bytes", (reason) => {
  const f = fixture(), source = join(f.research, "input"); writeFileSync(source, "bytes");
  let reads = 0;
  expect(() => prepareLaneBrief({ key: f.lane.key, stateDir: f.stateDir, briefText: source, requiredReport: false,
    readers: { security: () => reason, read: () => { reads++; return Buffer.alloc(0); } },
  })).toThrow(`(${reason})`);
  expect(reads).toBe(0);
});

for (const point of ["staged", "intent-written", "before-snapshot-rename", "snapshot-renamed", "completed"]) test(`first install resumes at ${point}`, async () => {
  const f = fixture();
  await expect(installLaneReports(f.stateDir, f.lane.key, output(), { ...f.options, step: (s) => { if (s === point) throw new Error("crash"); } })).rejects.toThrow();
  await installLaneReports(f.stateDir, f.lane.key, output(), f.options);
  expect(readFileSync(join(f.target, "report.md"), "utf8")).toBe("report");
  expect(f.notes.size).toBe(0);
});

test("unsafe ancestry and lock links refuse without following or modifying their targets", async () => {
  const f = fixture();
  rmSync(f.research, { recursive: true }); symlinkSync(f.stateDir, f.research);
  await expect(installLaneReports(f.stateDir, f.lane.key, output(), f.options)).rejects.toThrow("LANE_REPORT_DESTINATION_UNSAFE");
  rmSync(f.research); mkdirSync(f.research);
  const outside = join(f.dir, "outside"); writeFileSync(outside, "preserved");
  mkdirSync(join(f.stateDir, "lane-files"), { recursive: true });
  rmSync(join(f.stateDir, "lane-files", `${f.lane.key}.lock.sqlite`));
  symlinkSync(outside, join(f.stateDir, "lane-files", `${f.lane.key}.lock.sqlite`));
  await expect(installLaneReports(f.stateDir, f.lane.key, output(), f.options)).rejects.toThrow("LANE_REPORT_DESTINATION_UNSAFE");
  expect(readFileSync(outside, "utf8")).toBe("preserved");
});
