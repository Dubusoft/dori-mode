import { Database } from "bun:sqlite";
import {
  createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign,
  timingSafeEqual, verify, type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renameWithRetry } from "../setup.ts";
import { ensureRunnerSubdir, lockDownDatabase, RUNNER_PATHS, writeRunnerFile } from "./fs-safety.ts";
import { HUB_FILE } from "./hub.ts";
import {
  decodeFrame, encodeFrame, LABEL_PATTERN, ProtocolError, runnerControl,
  type Frame, type RejectCode, type RunnerControlBodies, type SupervisorControlBodies,
} from "./protocol.ts";
import type { Connector } from "./transport.ts";

/**
 * Runner and supervisor authentication: Ed25519 identity keys, one-time enrollment codes, a signed per-connection
 * handshake and a per-session HMAC on every later frame.
 *
 * Keys. The runner keeps its private key in `<runnerDir>/keys/runner.key` (PKCS#8 PEM, 0600) and the pinned supervisor
 * public key in `keys/supervisor.pub`; a key being rotated in waits in `keys/runner.next.key`. The supervisor keeps
 * its private key in `<stateDir>/runner-keys/supervisor.key` (0700 dir, 0600 file), and each runner's public key,
 * hostId and revocation in table `runner_keys` of `<stateDir>/runners.sqlite`. Public keys travel as base64 of the
 * raw 32 bytes; a fingerprint is `sha256:<hex of sha256(raw key)>`.
 *
 * Enrollment. `SupervisorAuth.issueCode(label)` makes a code of 32 random bytes, valid 10 minutes, bound to the label.
 * The runner sends `enroll {label, hostId, runnerPubKey, proof}` where `proof` is HMAC-SHA256 keyed with the code, so
 * the code is never on the wire. The supervisor accepts only a matching, unused, unexpired code of that label, marks
 * it used, stores the key and hostId, and answers `enroll.ok {supervisorPubKey, proof}`. The runner checks that proof
 * and the fingerprint it was given out of band, then pins the key.
 *
 * Handshake. `hello` carries the runner nonce and an ephemeral X25519 key. The supervisor answers `hello.challenge`
 * with its nonce, its ephemeral key, the fingerprint of the runner key it holds and its signature over the transcript
 * (both nonces, both ephemeral keys, both identity keys, label, hostId, gen). The runner checks that signature against
 * the pinned key and answers `auth.proof` with its own signature over the same transcript under a different role tag.
 * The session key is HKDF-SHA256 over the X25519 shared secret, salted with both nonces, with both identity keys in
 * the info; the ephemeral exchange keeps the key secret from anyone who only watched the handshake.
 *
 * Frames. Every frame after the handshake carries `mac` = base64 HMAC-SHA256(sessionKey, canonical JSON of the frame
 * without `mac`), keys sorted at every level so both sides hash the same bytes.
 */

export const ENROLL_CODE_BYTES = 32;
export const ENROLL_CODE_TTL_MS = 10 * 60_000;
export const NONCE_BYTES = 32;
/** Used codes are kept this long after they expire, so a reuse is refused as used rather than unknown. */
export const ENROLL_CODE_RETENTION_MS = 24 * 60 * 60_000;

/** Files under `<runnerDir>/keys`. */
export const RUNNER_KEY_FILES = { key: "runner.key", next: "runner.next.key", supervisor: "supervisor.pub" } as const;
/** The supervisor's key directory under its stateDir, and the key file in it. */
export const SUPERVISOR_KEY_DIR = "runner-keys";
export const SUPERVISOR_KEY_FILE = "supervisor.key";

const HANDSHAKE_TAG = "dori-runner-handshake-1";
const SESSION_INFO = "dori-runner-session-1";
const ENROLL_TAG = "dori-runner-enroll-1";
const ROTATE_TAG = "dori-runner-rotate-1";

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");

const REJECT_CODES: ReadonlySet<string> = new Set<RejectCode>([
  "RUNNER_PROTO_MISMATCH", "RUNNER_CONFLICT", "RUNNER_REVOKED", "RUNNER_AUTH_FAILED", "RUNNER_ENROLL_REFUSED",
]);
/** Whether a close reason names a reject code (the hub closes a refused connection with the code as the reason). */
export const isRejectCode = (value: string): value is RejectCode => REJECT_CODES.has(value);

// ---------------------------------------------------------------------------------------------------------------
// Keys and encodings
// ---------------------------------------------------------------------------------------------------------------

export type KeyPair = { readonly privateKey: KeyObject; readonly publicKey: KeyObject; /** base64 raw public key */ readonly pub: string };

const rawPublic = (key: KeyObject): Buffer => (key.export({ type: "spki", format: "der" }) as Buffer).subarray(ED25519_SPKI.length);

const importPublic = (b64: string, prefix: Buffer): KeyObject | undefined => {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== b64) return undefined;
  try { return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" }); } catch { return undefined; }
};

/** Whether `b64` is a well-formed Ed25519 public key. */
export const isPublicKey = (b64: string): boolean => importPublic(b64, ED25519_SPKI) !== undefined;

const pairOf = (privateKey: KeyObject): KeyPair => {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`RUNNER_KEY_INVALID not an Ed25519 key`);
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, pub: rawPublic(publicKey).toString("base64") };
};

export const generateKeyPair = (): KeyPair => pairOf(generateKeyPairSync("ed25519").privateKey);

/** The key pair stored at `path`, or undefined when there is no file. */
export const readKeyPair = (path: string): KeyPair | undefined =>
  existsSync(path) ? pairOf(createPrivateKey(readFileSync(path, "utf8"))) : undefined;

/** Writes the private key (PKCS#8 PEM) atomically with mode 0600. */
export const writeKeyPair = (path: string, pair: KeyPair): void => {
  writeRunnerFile(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string);
};

/** Loads the key pair at `path`, creating and storing a new one when the file is absent. */
export const loadOrCreateKeyPair = (path: string): KeyPair => {
  const existing = readKeyPair(path);
  if (existing) return existing;
  const pair = generateKeyPair();
  writeKeyPair(path, pair);
  return pair;
};

export const fingerprint = (pub: string): string => `sha256:${createHash("sha256").update(Buffer.from(pub, "base64")).digest("hex")}`;

/** JSON with object keys sorted at every level and undefined members left out. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record).sort().filter((k) => record[k] !== undefined);
    return `{${members.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const hmac = (key: Buffer, text: string): Buffer => createHmac("sha256", key).update(text).digest();

/** Constant-time comparison of an expected MAC with a received base64 one. */
const macMatches = (expected: Buffer, received: string): boolean => {
  const got = Buffer.from(received, "base64");
  return got.length === expected.length && timingSafeEqual(got, expected);
};

const signB64 = (pair: KeyPair, data: Buffer): string => sign(null, data, pair.privateKey).toString("base64");

const verifySig = (pub: string, data: Buffer, sig: string): boolean => {
  const key = importPublic(pub, ED25519_SPKI);
  if (!key) return false;
  try { return verify(null, data, key, Buffer.from(sig, "base64")); } catch { return false; }
};

const ephemeral = (): { readonly privateKey: KeyObject; readonly pub: string } => {
  const pair = generateKeyPairSync("x25519");
  return { privateKey: pair.privateKey, pub: rawPublic(pair.publicKey).toString("base64") };
};

const sharedSecret = (privateKey: KeyObject, peer: string): Buffer | undefined => {
  const key = importPublic(peer, X25519_SPKI);
  if (!key) return undefined;
  try {
    const secret = diffieHellman({ privateKey, publicKey: key });
    return secret.every((b) => b === 0) ? undefined : secret;
  } catch {
    return undefined;
  }
};

const isNonce = (b64: string | undefined): b64 is string => {
  if (b64 === undefined) return false;
  const raw = Buffer.from(b64, "base64");
  return raw.length === NONCE_BYTES && raw.toString("base64") === b64;
};

// ---------------------------------------------------------------------------------------------------------------
// Handshake and session
// ---------------------------------------------------------------------------------------------------------------

/** Everything both signatures cover. */
export type HandshakeParams = {
  readonly label: string; readonly hostId: string; readonly gen: number;
  readonly runnerNonce: string; readonly supervisorNonce: string;
  readonly runnerDh: string; readonly supervisorDh: string;
  readonly runnerPubKey: string; readonly supervisorPubKey: string;
};

/** The bytes one side signs; the role tag keeps a signature from one side from being replayed as the other's. */
export const transcript = (role: "runner" | "supervisor", params: HandshakeParams): Buffer =>
  Buffer.from(canonicalJson({ tag: HANDSHAKE_TAG, role, ...params }));

/** Computes `mac` for a frame (any `mac` already on it is ignored). */
export const frameMac = (key: Buffer, frame: Frame): string => {
  const { mac: _mac, ...rest } = frame;
  return hmac(key, canonicalJson(rest)).toString("base64");
};

/** One authenticated connection: seals outgoing frames and checks incoming ones. */
export class Session {
  constructor(private readonly key: Buffer, /** sha256 of the handshake, binding later proofs to this session */ readonly transcriptHash: Buffer) {}

  seal<F extends Frame>(frame: F): F {
    return { ...frame, mac: frameMac(this.key, frame) };
  }

  /** True when the frame carries the MAC this session's key gives it. */
  check(frame: Frame): boolean {
    if (typeof frame.mac !== "string") return false;
    const { mac: _mac, ...rest } = frame;
    return macMatches(hmac(this.key, canonicalJson(rest)), frame.mac);
  }
}

const deriveSession = (shared: Buffer, params: HandshakeParams): Session => {
  const salt = Buffer.concat([Buffer.from(params.runnerNonce, "base64"), Buffer.from(params.supervisorNonce, "base64")]);
  const info = Buffer.concat([Buffer.from(SESSION_INFO), Buffer.from(params.runnerPubKey, "base64"), Buffer.from(params.supervisorPubKey, "base64")]);
  const key = Buffer.from(hkdfSync("sha256", shared, salt, info, 32));
  return new Session(key, createHash("sha256").update(canonicalJson({ tag: HANDSHAKE_TAG, ...params })).digest());
};

const rotationMessage = (session: Session, label: string, cmdId: string, runnerPubKey: string): Buffer =>
  Buffer.from(canonicalJson({ tag: ROTATE_TAG, label, cmdId, runnerPubKey, transcript: session.transcriptHash.toString("base64") }));

const decodeCode = (code: string): Buffer | undefined => {
  const raw = Buffer.from(code, "base64url");
  return raw.length === ENROLL_CODE_BYTES && raw.toString("base64url") === code ? raw : undefined;
};

const enrollProof = (code: Buffer, fields: Record<string, string>): Buffer => hmac(code, canonicalJson({ tag: ENROLL_TAG, ...fields }));

export type AuthRefusal = { readonly ok: false; readonly code: RejectCode; readonly detail: string };
const refusal = (code: RejectCode, detail: string): AuthRefusal => ({ ok: false, code, detail });

// ---------------------------------------------------------------------------------------------------------------
// Supervisor side
// ---------------------------------------------------------------------------------------------------------------

export type SupervisorAuthOptions = {
  /** Wall clock for code expiry and the stored times. */
  readonly now: () => number;
  /** Random bytes for codes and nonces (default `crypto.randomBytes`). */
  readonly random?: (bytes: number) => Buffer;
};

/** A stored runner key row; `pubKey` is absent once revoked. */
export type RunnerKeyRow = {
  readonly label: string; readonly hostId: string; readonly pubKey?: string;
  readonly enrolledAt: number; readonly rotatedAt?: number; readonly revokedAt?: number;
};

/** A hello waiting for its `auth.proof`. */
export type PendingHello = { readonly params: HandshakeParams; readonly session: Session };

type KeyDbRow = { label: string; hostId: string; pubKey: string | null; enrolledAt: number; rotatedAt: number | null; revokedAt: number | null };

export class SupervisorAuth {
  /** The supervisor's identity key. */
  readonly keys: KeyPair;
  private readonly db: Database;
  private readonly random: (bytes: number) => Buffer;

  /** Loads or creates `<stateDir>/runner-keys/supervisor.key` and opens the key tables in `<stateDir>/runners.sqlite`. */
  constructor(readonly stateDir: string, private readonly options: SupervisorAuthOptions) {
    this.random = options.random ?? randomBytes;
    const dir = join(stateDir, SUPERVISOR_KEY_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.keys = loadOrCreateKeyPair(join(dir, SUPERVISOR_KEY_FILE));
    const path = join(stateDir, HUB_FILE);
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      `CREATE TABLE IF NOT EXISTS runner_keys (
        label TEXT PRIMARY KEY, hostId TEXT NOT NULL, pubKey TEXT, enrolledAt INTEGER NOT NULL, rotatedAt INTEGER, revokedAt INTEGER
      )`,
    );
    this.db.run("CREATE TABLE IF NOT EXISTS enroll_codes (code TEXT PRIMARY KEY, label TEXT NOT NULL, expiresAt INTEGER NOT NULL, usedAt INTEGER)");
    lockDownDatabase(path);
  }

  get publicKey(): string { return this.keys.pub; }
  get fingerprint(): string { return fingerprint(this.keys.pub); }

  /** A new one-time code for `label` (base64url of 32 random bytes), valid `ENROLL_CODE_TTL_MS`. */
  issueCode(label: string): { readonly code: string; readonly expiresAt: number } {
    if (!LABEL_PATTERN.test(label)) throw new Error(`RUNNER_LABEL_INVALID ${label}`);
    const now = this.options.now();
    const code = this.random(ENROLL_CODE_BYTES).toString("base64url");
    const expiresAt = now + ENROLL_CODE_TTL_MS;
    this.db.query("DELETE FROM enroll_codes WHERE expiresAt < ?").run(now - ENROLL_CODE_RETENTION_MS);
    this.db.query("INSERT INTO enroll_codes (code, label, expiresAt) VALUES (?, ?, ?)").run(code, label, expiresAt);
    return { code, expiresAt };
  }

  /** Accepts an `enroll` body when a code of its label matches and is unused and unexpired; the code is then used up. */
  enroll(body: RunnerControlBodies["enroll"]): { readonly ok: true; readonly reply: SupervisorControlBodies["enroll.ok"] } | AuthRefusal {
    const refuse = (detail: string) => refusal("RUNNER_ENROLL_REFUSED", detail);
    if (!isPublicKey(body.runnerPubKey)) return refuse("runnerPubKey is not an Ed25519 public key");
    const fields = { label: body.label, hostId: body.hostId, runnerPubKey: body.runnerPubKey };
    const rows = this.db.query("SELECT code, expiresAt, usedAt FROM enroll_codes WHERE label = ?").all(body.label) as
      { code: string; expiresAt: number; usedAt: number | null }[];
    const match = rows.find((row) => {
      const code = decodeCode(row.code);
      return code !== undefined && macMatches(enrollProof(code, fields), body.proof);
    });
    if (!match) return refuse(`no enrollment code of ${body.label} matches`);
    if (match.usedAt !== null) return refuse("enrollment code already used");
    const now = this.options.now();
    if (now >= match.expiresAt) return refuse("enrollment code expired");
    const stored = this.db.transaction(() => {
      if (this.db.query("UPDATE enroll_codes SET usedAt = ? WHERE code = ? AND usedAt IS NULL").run(now, match.code).changes !== 1) return false;
      this.db.query(
        `INSERT INTO runner_keys (label, hostId, pubKey, enrolledAt, rotatedAt, revokedAt) VALUES (?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(label) DO UPDATE SET hostId = excluded.hostId, pubKey = excluded.pubKey, enrolledAt = excluded.enrolledAt,
           rotatedAt = NULL, revokedAt = NULL`,
      ).run(body.label, body.hostId, body.runnerPubKey, now);
      // Enrollment can run in the installer before a hub opens. Rebind an existing row just as hub enrollment does.
      if (this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runners'").get()) {
        this.db.query("UPDATE runners SET hostId = ? WHERE label = ?").run(body.hostId, body.label);
      }
      return true;
    }).immediate();
    if (!stored) return refuse("enrollment code already used");
    lockDownDatabase(join(this.stateDir, HUB_FILE));
    const code = decodeCode(match.code) as Buffer;
    return {
      ok: true,
      reply: {
        supervisorPubKey: this.keys.pub,
        proof: enrollProof(code, { ...fields, supervisorPubKey: this.keys.pub, role: "supervisor" }).toString("base64"),
      },
    };
  }

  key(label: string): RunnerKeyRow | undefined {
    const r = this.db.query("SELECT label, hostId, pubKey, enrolledAt, rotatedAt, revokedAt FROM runner_keys WHERE label = ?").get(label) as KeyDbRow | null;
    if (!r) return undefined;
    return {
      label: r.label, hostId: r.hostId, enrolledAt: r.enrolledAt,
      ...(r.pubKey !== null ? { pubKey: r.pubKey } : {}),
      ...(r.rotatedAt !== null ? { rotatedAt: r.rotatedAt } : {}),
      ...(r.revokedAt !== null ? { revokedAt: r.revokedAt } : {}),
    };
  }

  /**
   * Checks a hello against the stored key (`RUNNER_AUTH_FAILED` when not enrolled, on another hostId or without a
   * nonce; `RUNNER_REVOKED` when revoked) and builds the signed `hello.challenge`.
   */
  beginHello(body: RunnerControlBodies["hello"]):
    { readonly ok: true; readonly challenge: SupervisorControlBodies["hello.challenge"]; readonly pending: PendingHello } | AuthRefusal {
    const row = this.key(body.label);
    if (!row) return refusal("RUNNER_AUTH_FAILED", `runner ${body.label} is not enrolled`);
    if (row.revokedAt !== undefined || row.pubKey === undefined) return refusal("RUNNER_REVOKED", `runner ${body.label} is revoked`);
    if (row.hostId !== body.hostId) return refusal("RUNNER_AUTH_FAILED", `hostId ${body.hostId} differs from the enrolled host`);
    if (!isNonce(body.nonce) || body.dh === undefined) return refusal("RUNNER_AUTH_FAILED", "hello carries no handshake nonce");
    const eph = ephemeral();
    const shared = sharedSecret(eph.privateKey, body.dh);
    if (!shared) return refusal("RUNNER_AUTH_FAILED", "hello dh is not a usable X25519 key");
    const params: HandshakeParams = {
      label: body.label, hostId: body.hostId, gen: body.gen,
      runnerNonce: body.nonce, supervisorNonce: this.random(NONCE_BYTES).toString("base64"),
      runnerDh: body.dh, supervisorDh: eph.pub, runnerPubKey: row.pubKey, supervisorPubKey: this.keys.pub,
    };
    return {
      ok: true,
      challenge: { nonce: params.supervisorNonce, dh: eph.pub, sig: signB64(this.keys, transcript("supervisor", params)), keyFp: fingerprint(row.pubKey) },
      pending: { params, session: deriveSession(shared, params) },
    };
  }

  /** The session when `sig` is the runner's signature over the transcript with the key still on file; else undefined. */
  finishHello(pending: PendingHello, sig: string): Session | undefined {
    const params = pending.params;
    if (this.key(params.label)?.pubKey !== params.runnerPubKey) return undefined;
    return verifySig(params.runnerPubKey, transcript("runner", params), sig) ? pending.session : undefined;
  }

  /** Replaces the label's key with the one in `runner.rotated` when its signature (new key, this session) checks. */
  rotate(label: string, session: Session, body: RunnerControlBodies["runner.rotated"]): boolean {
    if (!verifySig(body.runnerPubKey, rotationMessage(session, label, body.cmdId, body.runnerPubKey), body.sig)) return false;
    return this.db.query("UPDATE runner_keys SET pubKey = ?, rotatedAt = ? WHERE label = ? AND pubKey IS NOT NULL AND revokedAt IS NULL")
      .run(body.runnerPubKey, this.options.now(), label).changes === 1;
  }

  /** Deletes the label's key and marks it revoked; later hellos get `RUNNER_REVOKED` until it enrolls again. */
  revoke(label: string): boolean {
    return this.db.query("UPDATE runner_keys SET pubKey = NULL, revokedAt = ? WHERE label = ?").run(this.options.now(), label).changes === 1;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Runner side
// ---------------------------------------------------------------------------------------------------------------

/** The runner's half of an open hello. */
export type PendingRunnerHello = { readonly nonce: string; readonly dh: string; readonly dhKey: KeyObject };

export type ChallengeAnswer =
  | { readonly ok: true; readonly session: Session; readonly sig: string }
  | { readonly ok: false; readonly detail: string };

export class RunnerAuth {
  /** `<runnerDir>/keys` (0700). */
  readonly dir: string;
  private readonly random: (bytes: number) => Buffer;

  constructor(runnerDir: string, options: { readonly random?: (bytes: number) => Buffer } = {}) {
    this.dir = ensureRunnerSubdir(runnerDir, RUNNER_PATHS.keys);
    this.random = options.random ?? randomBytes;
  }

  private path(name: keyof typeof RUNNER_KEY_FILES): string {
    return join(this.dir, RUNNER_KEY_FILES[name]);
  }

  /** The runner's current key pair, created on first use. */
  keyPair(): KeyPair {
    return loadOrCreateKeyPair(this.path("key"));
  }

  /** The pinned supervisor public key, when enrolled. */
  supervisorKey(): string | undefined {
    const path = this.path("supervisor");
    return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
  }

  get enrolled(): boolean {
    return this.supervisorKey() !== undefined;
  }

  /** The `enroll` body for `code` (the code stays here; only an HMAC keyed with it is sent). */
  enrollRequest(code: string, label: string, hostId: string): RunnerControlBodies["enroll"] {
    const raw = decodeCode(code);
    if (!raw) throw new Error("RUNNER_ENROLL_CODE_INVALID the code is not 32 bytes of base64url");
    const runnerPubKey = this.keyPair().pub;
    return { label, hostId, runnerPubKey, proof: enrollProof(raw, { label, hostId, runnerPubKey }).toString("base64") };
  }

  /**
   * Pins the supervisor key from `enroll.ok` after checking it has `expectedFingerprint` and that the reply's proof
   * was made with the same code. Throws `RUNNER_AUTH_FAILED ...` otherwise, and nothing is written.
   */
  pinSupervisor(code: string, request: RunnerControlBodies["enroll"], reply: SupervisorControlBodies["enroll.ok"], expectedFingerprint: string): void {
    if (!isPublicKey(reply.supervisorPubKey)) throw new Error("RUNNER_AUTH_FAILED supervisorPubKey is not an Ed25519 public key");
    const got = fingerprint(reply.supervisorPubKey);
    if (got !== expectedFingerprint.trim().toLowerCase()) throw new Error(`RUNNER_AUTH_FAILED supervisor key ${got} is not the expected ${expectedFingerprint}`);
    const raw = decodeCode(code);
    const fields = { label: request.label, hostId: request.hostId, runnerPubKey: request.runnerPubKey, supervisorPubKey: reply.supervisorPubKey, role: "supervisor" };
    if (!raw || !macMatches(enrollProof(raw, fields), reply.proof)) throw new Error("RUNNER_AUTH_FAILED enroll.ok proof does not match the code");
    writeRunnerFile(this.path("supervisor"), `${reply.supervisorPubKey}\n`);
  }

  /** A fresh nonce and ephemeral key for one hello. */
  startHello(): PendingRunnerHello {
    const eph = ephemeral();
    return { nonce: this.random(NONCE_BYTES).toString("base64"), dh: eph.pub, dhKey: eph.privateKey };
  }

  /**
   * Checks `hello.challenge` against the pinned key and returns the session and the runner's transcript signature.
   * The challenge names the runner key the supervisor holds: the current one, or the rotated-in one when the
   * supervisor stored it but its `rotate.ok` never arrived (that key is then promoted here).
   */
  answerChallenge(pending: PendingRunnerHello, hello: { readonly label: string; readonly hostId: string; readonly gen: number },
    challenge: SupervisorControlBodies["hello.challenge"]): ChallengeAnswer {
    const supervisorPubKey = this.supervisorKey();
    if (!supervisorPubKey) return { ok: false, detail: "no pinned supervisor key; enroll first" };
    const current = this.keyPair();
    const next = readKeyPair(this.path("next"));
    const chosen = fingerprint(current.pub) === challenge.keyFp ? current : next && fingerprint(next.pub) === challenge.keyFp ? next : undefined;
    if (!chosen) return { ok: false, detail: "the supervisor holds another key for this runner" };
    const params: HandshakeParams = {
      label: hello.label, hostId: hello.hostId, gen: hello.gen,
      runnerNonce: pending.nonce, supervisorNonce: challenge.nonce, runnerDh: pending.dh, supervisorDh: challenge.dh,
      runnerPubKey: chosen.pub, supervisorPubKey,
    };
    if (!isNonce(challenge.nonce) || !verifySig(supervisorPubKey, transcript("supervisor", params), challenge.sig)) {
      return { ok: false, detail: "hello answer is not signed by the pinned supervisor key" };
    }
    const shared = sharedSecret(pending.dhKey, challenge.dh);
    if (!shared) return { ok: false, detail: "challenge dh is not a usable X25519 key" };
    if (chosen === next) this.confirmRotate();
    return { ok: true, session: deriveSession(shared, params), sig: signB64(chosen, transcript("runner", params)) };
  }

  /** The `runner.rotated` body: a new key pair (kept in `runner.next.key` until confirmed), signed for this session. */
  rotateAnswer(session: Session, label: string, cmdId: string): RunnerControlBodies["runner.rotated"] {
    let next = readKeyPair(this.path("next"));
    if (!next) {
      next = generateKeyPair();
      writeKeyPair(this.path("next"), next);
    }
    return { cmdId, runnerPubKey: next.pub, sig: signB64(next, rotationMessage(session, label, cmdId, next.pub)) };
  }

  /** Makes the rotated-in key current; the old private key is gone once the rename lands. No-op without one. */
  confirmRotate(): void {
    if (existsSync(this.path("next"))) renameWithRetry(this.path("next"), this.path("key"));
  }
}

export type EnrollOutcome =
  | { readonly ok: true; readonly supervisorFingerprint: string }
  | { readonly ok: false; readonly code: RejectCode | "RUNNER_UNREACHABLE" | "RUNNER_CLOSED"; readonly detail: string };

export type EnrollParams = {
  readonly auth: RunnerAuth;
  readonly connect: Connector;
  /** The one-time code, handed to the runner out of band (ssh stdin). */
  readonly code: string;
  readonly label: string;
  readonly hostId: string;
  /** The supervisor key fingerprint the runner must see before it pins the key. */
  readonly expectedFingerprint: string;
};

/** First SSH pass emits only the enrollment proof; the second verifies and pins the supervisor's reply. */
export const enrollOverStdio = (params: Omit<EnrollParams, "connect">, reply?: string): string | undefined => {
  const request = params.auth.enrollRequest(params.code, params.label, params.hostId);
  if (reply === undefined) return encodeFrame(runnerControl({ runner: params.label, gen: 0, epoch: 0 }, "enroll", request)).trimEnd();
  const frame = decodeFrame(Buffer.from(reply, "base64").toString("utf8"), "supervisor");
  if (frame.type !== "enroll.ok" || frame.runner !== params.label) throw new Error("RUNNER_AUTH_FAILED expected enroll.ok for this runner");
  params.auth.pinSupervisor(params.code, request, frame.body as SupervisorControlBodies["enroll.ok"], params.expectedFingerprint);
};

/** Runs one enrollment exchange on a new connection and closes it; on success `keys/supervisor.pub` is pinned. */
export const enrollRunner = async (params: EnrollParams): Promise<EnrollOutcome> => {
  let transport;
  try {
    transport = await params.connect();
  } catch (error) {
    return { ok: false, code: "RUNNER_UNREACHABLE", detail: error instanceof Error ? error.message : String(error) };
  }
  const request = params.auth.enrollRequest(params.code, params.label, params.hostId);
  const link = transport;
  return new Promise<EnrollOutcome>((resolve) => {
    let done = false;
    const finish = (outcome: EnrollOutcome): void => {
      if (done) return;
      done = true;
      offLine();
      offClose();
      link.close(outcome.ok ? "enrolled" : outcome.code);
      resolve(outcome);
    };
    const offLine = link.onLine((line) => {
      let frame;
      try {
        frame = decodeFrame(line, "supervisor");
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        finish({ ok: false, code: "RUNNER_AUTH_FAILED", detail: error.message });
        return;
      }
      if (frame.type === "enroll.ok") {
        try {
          params.auth.pinSupervisor(params.code, request, frame.body as SupervisorControlBodies["enroll.ok"], params.expectedFingerprint);
          finish({ ok: true, supervisorFingerprint: fingerprint((frame.body as SupervisorControlBodies["enroll.ok"]).supervisorPubKey) });
        } catch (error) {
          finish({ ok: false, code: "RUNNER_AUTH_FAILED", detail: error instanceof Error ? error.message : String(error) });
        }
      } else if (frame.type === "hello.reject") {
        const body = frame.body as SupervisorControlBodies["hello.reject"];
        finish({ ok: false, code: body.code, detail: body.detail });
      }
    });
    const offClose = link.onClose((reason) => {
      finish({ ok: false, code: isRejectCode(reason) ? reason : "RUNNER_CLOSED", detail: reason });
    });
    link.send(encodeFrame(runnerControl({ runner: params.label, gen: 0, epoch: 0 }, "enroll", request)));
  });
};
