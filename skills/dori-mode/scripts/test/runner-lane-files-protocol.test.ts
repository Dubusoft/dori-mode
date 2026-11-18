import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { canonicalJson, frameMac } from "../src/runner/auth.ts";
import {
  checkProto, decodeFrame, encodeFrame, ENVELOPE_VERSION, isQueryType, MAX_FRAME_BYTES, PROTO, QUERY_TYPES, runnerControl, runnerEvent,
  supervisorCommand, supervisorControl,
  type LaneBriefFiles, type LaneFileLimits, type LaneOutputFiles, type QueryResults, type SupervisorCommandBodies,
} from "../src/runner/protocol.ts";

const HEAD = { runner: "r1", gen: 2, epoch: 7 };
const RUN = { id: "0b6f3c1e-5d2a-4f7b-9c8e-1a2b3c4d5e6f", requiredReport: true } as const;

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const file = (path: string, bytes: Uint8Array) => ({ path, bytes: bytes.length, sha256: sha(bytes), base64: Buffer.from(bytes).toString("base64") });

/** Every byte value, a NUL-led binary blob, and a zero-byte file. */
const BINARY = Uint8Array.from({ length: 256 }, (_, i) => i);
const BINARY_TREE = {
  directories: ["r0000", "r0000/empty", "r0000/notes"],
  files: [file("r0000/notes/blob.bin", BINARY), file("r0000/notes/zero", new Uint8Array(0))],
};
const EMPTY_TREE = { directories: [], files: [] };

const BRIEF = "update /lead/research/x/notes.md:12\n";
const briefFiles = (tree: LaneBriefFiles["tree"]): LaneBriefFiles => ({
  run: RUN, tree, references: tree.files.length > 0 ? [{ start: 7, end: 32, target: "r0000/notes" }] : [],
});
const outputFiles = (tree: LaneOutputFiles["tree"], revision = 1): LaneOutputFiles => ({ run: RUN, revision, sha256: "a".repeat(64), tree });

const startBody = (extra: Partial<SupervisorCommandBodies["lane.start"]> = {}): SupervisorCommandBodies["lane.start"] => ({
  cmdId: "op-1", key: "lane-a", briefText: BRIEF, done: "", thread: "t", cwd: "/w", agentProfile: "senpi", mode: "code", model: "m",
  sandbox: true, expectedLaneGen: 3, ...extra,
});

const viaRunner = (frame: Parameters<typeof encodeFrame>[0]) => decodeFrame(encodeFrame(frame), "runner");
const viaSupervisor = (frame: Parameters<typeof encodeFrame>[0]) => decodeFrame(encodeFrame(frame), "supervisor");
/** Decodes a frame built from a raw (possibly malformed) body. */
const rawDecode = (frame: Record<string, unknown>, from: "runner" | "supervisor") => () => decodeFrame(JSON.stringify(frame), from);

describe("lane file wire types: round trips", () => {
  test("LaneFileLimits pins the exact values both endpoints check with satisfies", () => {
    const limits = {
      fileBytes: 262144, totalBytes: 393216, files: 64, directories: 128, references: 256, depth: 16, relativePathBytes: 240,
      componentBytes: 120, sourcePathBytes: 4096, briefBytes: 65536, reportTextBytes: 65536, evidenceBytes: 16384, wireBodyBytes: 786432,
    } as const satisfies LaneFileLimits;
    // A wrong literal fails typecheck; the object itself is exactly the spec table.
    // @ts-expect-error fileBytes is the literal 262144
    const wrong: LaneFileLimits = { ...limits, fileBytes: 262145 };
    expect(Number(wrong.fileBytes)).toBe(262145);
    expect(Object.keys(limits)).toHaveLength(13);
  });

  test("lane.start with empty and binary input snapshots decodes to exactly the sent body", () => {
    for (const tree of [EMPTY_TREE, BINARY_TREE]) {
      const body = startBody({ files: briefFiles(tree) });
      const frame = viaSupervisor(supervisorCommand(HEAD, 1, "lane.start", body));
      expect(frame.body).toEqual(body);
      expect(Object.keys((frame.body as typeof body).files ?? {})).toEqual(["run", "tree", "references"]);
    }
    const decoded = viaSupervisor(supervisorCommand(HEAD, 2, "lane.start", startBody({ files: briefFiles(BINARY_TREE) }))).body as SupervisorCommandBodies["lane.start"];
    const blob = decoded.files?.tree.files[0];
    expect(Buffer.from(blob?.base64 ?? "", "base64")).toEqual(Buffer.from(BINARY));
    expect(blob?.sha256).toBe(sha(BINARY));
  });

  test("lane.recover carries a fresh brief/files pair, and its legacy form without them still decodes", () => {
    const fresh = { cmdId: "op-2", key: "lane-a", session: "s", tabWorkspace: "lanes", briefText: BRIEF, files: briefFiles(BINARY_TREE) };
    expect(viaSupervisor(supervisorCommand(HEAD, 3, "lane.recover", fresh)).body).toEqual(fresh);
    const legacy = { cmdId: "op-3", key: "lane-a" };
    expect(viaSupervisor(supervisorCommand(HEAD, 4, "lane.recover", legacy)).body).toEqual(legacy);
  });

  test("recover-pair: a half pair is structurally valid; pairing is the endpoints' semantic check", () => {
    // Fixtures for the endpoint suites: decodeFrame accepts both, and the receiving endpoint must refuse them with
    // LANE_FILES_INVALID <key>: invalid file payload (recover-pair); ...
    const briefOnly = { cmdId: "op-4", key: "lane-a", briefText: BRIEF };
    const filesOnly = { cmdId: "op-5", key: "lane-a", files: briefFiles(EMPTY_TREE) };
    expect(viaSupervisor(supervisorCommand(HEAD, 5, "lane.recover", briefOnly)).body).toEqual(briefOnly);
    expect(viaSupervisor(supervisorCommand(HEAD, 6, "lane.recover", filesOnly)).body).toEqual(filesOnly);
  });

  test("lane.started carries fileRun; the old-shaped event still decodes", () => {
    const started = { key: "lane-a", pane: "w1:p2", tab: "w1:t1", session: "s-1", fileRun: RUN };
    expect(viaRunner(runnerEvent(HEAD, 1, "lane.started", started)).body).toEqual(started);
    const old = { key: "lane-a", pane: "w1:p2", tab: "w1:t1", session: "s-1" };
    expect(viaRunner(runnerEvent(HEAD, 2, "lane.started", old)).body).toEqual(old);
  });

  test("lane.report done carries an output snapshot alongside text, evidence and bodyRef", () => {
    for (const tree of [EMPTY_TREE, BINARY_TREE]) {
      const report = {
        key: "lane-a", kind: "done" as const, text: "finished", evidence: "tests pass",
        bodyRef: { sha256: "b".repeat(64), bytes: 8, truncated: false }, files: outputFiles(tree, 3),
      };
      expect(viaRunner(runnerEvent(HEAD, 3, "lane.report", report)).body).toEqual(report);
    }
  });

  test("q.lane.files is a supervisor query answered by q.result with or without files", () => {
    expect(QUERY_TYPES).toContain("q.lane.files");
    expect(isQueryType("q.lane.files")).toBe(true);
    const query = viaSupervisor(supervisorControl(HEAD, "q.lane.files", { qid: "q1", key: "lane-a" }));
    expect(query.body).toEqual({ qid: "q1", key: "lane-a" });
    expect("cmdSeq" in query).toBe(false);
    expect(rawDecode({ ...supervisorControl(HEAD, "q.lane.files", { qid: "q1", key: "lane-a" }) }, "runner")).toThrow("wrong-direction");
    const managed: QueryResults["q.lane.files"] = { files: outputFiles(BINARY_TREE, 2) };
    const legacy: QueryResults["q.lane.files"] = {};
    for (const result of [managed, legacy]) {
      const answer = { qid: "q1", ok: true, detail: "ok", result };
      expect(viaRunner(runnerControl(HEAD, "q.result", answer)).body).toEqual(answer);
    }
  });
});

describe("lane file wire types: strict structure", () => {
  const started = runnerEvent(HEAD, 1, "lane.started", { key: "lane-a", pane: "p", tab: "t", session: "s", fileRun: RUN });
  const report = runnerEvent(HEAD, 2, "lane.report", { key: "lane-a", kind: "done", text: "x", files: outputFiles(BINARY_TREE) });
  const start = supervisorCommand(HEAD, 1, "lane.start", startBody({ files: briefFiles(BINARY_TREE) }));
  const withBody = <F extends { body: object }>(frame: F, body: unknown) => ({ ...frame, body }) as Record<string, unknown>;

  test("missing nested fields are rejected with their path", () => {
    const { requiredReport: _r, ...runNoFlag } = RUN;
    expect(rawDecode(withBody(started, { ...started.body, fileRun: runNoFlag }), "runner")).toThrow("RUNNER_FRAME_INVALID missing-field body.fileRun.requiredReport");
    const { revision: _v, ...noRevision } = report.body.files as LaneOutputFiles;
    expect(rawDecode(withBody(report, { ...report.body, files: noRevision }), "runner")).toThrow("RUNNER_FRAME_INVALID missing-field body.files.revision");
    const { base64: _b, ...noBase64 } = BINARY_TREE.files[0] as (typeof BINARY_TREE.files)[0];
    const tree = { ...BINARY_TREE, files: [noBase64] };
    expect(rawDecode(withBody(start, { ...start.body, files: { ...start.body.files, tree } }), "supervisor"))
      .toThrow("RUNNER_FRAME_INVALID missing-field body.files.tree.files[0].base64");
    const { references: _refs, ...noRefs } = start.body.files as LaneBriefFiles;
    expect(rawDecode(withBody(start, { ...start.body, files: noRefs }), "supervisor")).toThrow("RUNNER_FRAME_INVALID missing-field body.files.references");
    expect(rawDecode(withBody(supervisorControl(HEAD, "q.lane.files", { qid: "q", key: "k" }), { qid: "q" }), "supervisor"))
      .toThrow("RUNNER_FRAME_INVALID missing-field body.key");
  });

  test("wrong types and negative integers are rejected", () => {
    const files = report.body.files as LaneOutputFiles;
    const cases: [Record<string, unknown>, string][] = [
      [withBody(report, { ...report.body, files: { ...files, revision: -1 } }), "field-type body.files.revision must be a non-negative integer"],
      [withBody(report, { ...report.body, files: { ...files, revision: 1.5 } }), "field-type body.files.revision must be a non-negative integer"],
      [withBody(report, { ...report.body, files: { ...files, sha256: 5 } }), "field-type body.files.sha256 must be a string"],
      [withBody(report, { ...report.body, files: { ...files, run: { ...RUN, requiredReport: "yes" } } }), "field-type body.files.run.requiredReport must be a boolean"],
      [withBody(report, { ...report.body, files: { ...files, tree: { ...BINARY_TREE, directories: [1] } } }), "field-type body.files.tree.directories must be an array of strings"],
      [withBody(report, { ...report.body, files: { ...files, tree: { ...BINARY_TREE, files: {} } } }), "field-type body.files.tree.files must be an array"],
      [withBody(report, { ...report.body, files: { ...files, tree: { ...BINARY_TREE, files: [{ ...BINARY_TREE.files[0], bytes: -2 }] } } }),
        "field-type body.files.tree.files[0].bytes must be a non-negative integer"],
      [withBody(report, { ...report.body, files: "inline" }), "field-type body.files must be an object"],
      [withBody(started, { ...started.body, fileRun: { ...RUN, id: 7 } }), "field-type body.fileRun.id must be a string"],
    ];
    for (const [frame, message] of cases) expect(rawDecode(frame, "runner")).toThrow(`RUNNER_FRAME_INVALID ${message}`);
    const brief = start.body.files as LaneBriefFiles;
    expect(rawDecode(withBody(start, { ...start.body, files: { ...brief, references: [{ start: -1, end: 4, target: "r0000" }] } }), "supervisor"))
      .toThrow("RUNNER_FRAME_INVALID field-type body.files.references[0].start must be a non-negative integer");
    expect(rawDecode(withBody(start, { ...start.body, files: { ...brief, references: [{ start: 0, end: "4", target: "r0000" }] } }), "supervisor"))
      .toThrow("RUNNER_FRAME_INVALID field-type body.files.references[0].end must be a non-negative integer");
    const recover = supervisorCommand(HEAD, 2, "lane.recover", { cmdId: "c", key: "k" });
    expect(rawDecode(withBody(recover, { cmdId: "c", key: "k", briefText: 3 }), "supervisor")).toThrow("RUNNER_FRAME_INVALID field-type body.briefText must be a string");
  });

  test("unknown fields fail at every nesting level", () => {
    const files = report.body.files as LaneOutputFiles;
    const brief = start.body.files as LaneBriefFiles;
    expect(rawDecode(withBody(report, { ...report.body, files: { ...files, extra: 1 } }), "runner")).toThrow("RUNNER_FRAME_INVALID unknown-field body.files.extra");
    expect(rawDecode(withBody(report, { ...report.body, files: { ...files, run: { ...RUN, gen: 1 } } }), "runner")).toThrow("unknown-field body.files.run.gen");
    expect(rawDecode(withBody(report, { ...report.body, files: { ...files, tree: { ...BINARY_TREE, links: [] } } }), "runner")).toThrow("unknown-field body.files.tree.links");
    expect(rawDecode(withBody(report, { ...report.body, files: { ...files, tree: { ...BINARY_TREE, files: [{ ...BINARY_TREE.files[0], mode: 0o755 }] } } }), "runner"))
      .toThrow("unknown-field body.files.tree.files[0].mode");
    expect(rawDecode(withBody(start, { ...start.body, files: { ...brief, references: [{ start: 0, end: 1, target: "r0000", source: "/x" }] } }), "supervisor"))
      .toThrow("unknown-field body.files.references[0].source");
    expect(rawDecode(withBody(started, { ...started.body, fileRun: { ...RUN, revision: 1 } }), "runner")).toThrow("unknown-field body.fileRun.revision");
    expect(rawDecode(withBody(supervisorControl(HEAD, "q.lane.files", { qid: "q", key: "k" }), { qid: "q", key: "k", path: "/x" }), "supervisor"))
      .toThrow("unknown-field body.path");
    // Files are an input on start/recover and an output on reports: not accepted on events or commands that do not name them.
    expect(rawDecode(withBody(started, { ...started.body, files: outputFiles(EMPTY_TREE) }), "runner")).toThrow("unknown-field body.files");
    const stop = supervisorCommand(HEAD, 3, "lane.stop", { cmdId: "c", key: "k" });
    expect(rawDecode(withBody(stop, { cmdId: "c", key: "k", files: briefFiles(EMPTY_TREE) }), "supervisor")).toThrow("unknown-field body.files");
  });

  test("unknown event and query types are rejected", () => {
    expect(rawDecode({ ...runnerEvent(HEAD, 1, "lane.ack", { key: "k", id: "i" }), type: "lane.files" }, "runner")).toThrow("RUNNER_FRAME_INVALID unknown-type lane.files");
    expect(rawDecode({ ...supervisorControl(HEAD, "q.panes", { qid: "q" }), type: "q.lane.fetch" }, "supervisor")).toThrow("RUNNER_FRAME_INVALID unknown-type q.lane.fetch");
    expect(isQueryType("q.lane.fetch")).toBe(false);
  });
});

describe("proto 9 window", () => {
  test("admits 9 and 8, rejects 7 with the update hint and 10 as newer", () => {
    expect(PROTO).toBe(9);
    expect(checkProto(9)).toEqual({ ok: true });
    expect(checkProto(8)).toEqual({ ok: true });
    expect(checkProto(7)).toEqual({
      ok: false, code: "RUNNER_PROTO_MISMATCH", detail: "runner proto 7 is too old for the supervisor (accepts 8..9); run dori runner update",
    });
    expect(checkProto(10)).toEqual({ ok: false, code: "RUNNER_PROTO_MISMATCH", detail: "runner proto 10 is newer than the supervisor (accepts 8..9)" });
  });
});

describe("historical proto 4 frames still decode without the new fields", () => {
  test("reports, command results, inventory hello and start bodies", () => {
    const report = { key: "lane-a", kind: "done" as const, text: "done", evidence: "e", bodyRef: { sha256: "c".repeat(64), bytes: 4, truncated: true } };
    expect(viaRunner(runnerEvent(HEAD, 1, "lane.report", report)).body).toEqual(report);
    const progress = { key: "lane-a", kind: "progress" as const, text: "half way" };
    expect(viaRunner(runnerEvent(HEAD, 2, "lane.report", progress)).body).toEqual(progress);
    const result = { cmdId: "c", cmdSeq: 4, state: "verified" as const, detail: "started", result: { pane: "p", tab: "t", startup: { verdict: "ok", detail: "" } } };
    expect(viaRunner(runnerEvent(HEAD, 3, "cmd.result", result)).body).toEqual(result);
    const hello = {
      proto: 4, gen: 2, label: "r1", hostId: "h", cmdAck: 9, version: "0.9", inventory: [{ key: "lane-a", pane: "p", tab: "t", session: "s" }, { key: "lane-b", pane: "q", tab: "u" }],
    };
    expect(viaRunner(runnerControl(HEAD, "hello", hello)).body).toEqual(hello);
    const legacyStart = startBody({ keywords: "go", session: "s", target: { workspace: "w" }, heavySlots: 1, heavyMaxLoad: 2.5, tabWorkspace: "lanes" });
    expect(viaSupervisor(supervisorCommand(HEAD, 5, "lane.start", legacyStart)).body).toEqual(legacyStart);
    const queryAnswer = { qid: "q", ok: true, detail: "ok", result: { exists: [true, false] } };
    expect(viaRunner(runnerControl(HEAD, "q.result", queryAnswer)).body).toEqual(queryAnswer);
  });
});

describe("frame budget and envelope layout", () => {
  /** A done report whose encoded line (newline included) is exactly `total` bytes, padded with `unit` in the text. */
  const reportLine = (total: number, unit: string): string => {
    const make = (text: string) => encodeFrame(runnerEvent(HEAD, 1, "lane.report", { key: "lane-a", kind: "done", text, files: outputFiles(BINARY_TREE) }));
    const base = Buffer.byteLength(make(""), "utf8");
    const unitBytes = Buffer.byteLength(JSON.stringify(unit), "utf8") - 2;
    const units = Math.floor((total - base) / unitBytes);
    const text = unit.repeat(units) + "a".repeat(total - base - units * unitBytes);
    const line = make(text);
    expect(Buffer.byteLength(line, "utf8")).toBe(total);
    return line;
  };

  test("a frame of exactly MAX_FRAME_BYTES decodes and one byte more is refused, for ASCII, multibyte and escaped text", () => {
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
    for (const unit of ["a", "\u00e9", "\u{1F600}", "\u0001", "\""]) {
      const fits = decodeFrame(reportLine(MAX_FRAME_BYTES, unit), "runner");
      expect(fits.type).toBe("lane.report");
      expect(() => decodeFrame(reportLine(MAX_FRAME_BYTES + 1, unit), "runner")).toThrow("RUNNER_FRAME_INVALID frame-too-large");
    }
  });

  test("decoded text survives multibyte and escaped content intact", () => {
    const text = "\u00e9\u{1F600}\u0001\"\\\n\t";
    const body = { key: "lane-a", kind: "done" as const, text, evidence: text, files: outputFiles(BINARY_TREE) };
    expect(viaRunner(runnerEvent(HEAD, 1, "lane.report", body)).body).toEqual(body);
  });

  test("the envelope version is unchanged and the MAC covers the same canonical body bytes", () => {
    expect(ENVELOPE_VERSION).toBe(1);
    const frame = runnerEvent(HEAD, 1, "lane.report", { key: "lane-a", kind: "done", text: "x", files: outputFiles(BINARY_TREE) });
    expect(Object.keys(JSON.parse(encodeFrame(frame)))).toEqual(["v", "runner", "gen", "epoch", "seq", "type", "body"]);
    expect(JSON.parse(encodeFrame(frame)).v).toBe(1);
    const key = Buffer.alloc(32, 7);
    const mac = frameMac(key, frame);
    expect(mac).toBe(createHmac("sha256", key).update(canonicalJson(frame)).digest("base64"));
    // The MAC of the decoded frame equals the sender's: decoding neither adds nor drops any body field.
    const decoded = decodeFrame(encodeFrame({ ...frame, mac }), "runner");
    expect(decoded.mac).toBe(mac);
    expect(frameMac(key, decoded)).toBe(mac);
  });
});
