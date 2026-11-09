/**
 * Windows ownership and DACL checks for the runner directory. `readSddl` reads an entry's owner and DACL as SDDL through
 * advapi32 (bun:ffi), opening the entry itself rather than a reparse point's target; `evaluateSddl` is the pure policy
 * `fs-safety.ts` applies to it. The FFI libraries are opened on first use only, so importing this module on another
 * platform never touches them.
 */

/** An entry's owner SID, its SDDL (owner and DACL), and its reparse tag when it is a reparse point. */
export type AclInfo = { readonly owner: string; readonly sddl: string; readonly reparseTag?: number };

/** Why an SDDL fails the policy, with the `RUNNER_DIR_UNSAFE` detail (`owner=<sid>`, `allow=<sid>`, `dacl=...`). */
export type AclVerdict = { readonly reason: "owner" | "acl"; readonly detail: string };

export const SYSTEM_SID = "S-1-5-18";
export const ADMINISTRATORS_SID = "S-1-5-32-544";
export const CREATOR_OWNER_SID = "S-1-3-0";
/** The reparse tag of an AF_UNIX socket file. */
export const IO_REPARSE_TAG_AF_UNIX = 0x80000023;

/** Well-known SDDL SID aliases that do not depend on the domain or machine. */
export const SID_ALIASES: Readonly<Record<string, string>> = {
  WD: "S-1-1-0", CO: "S-1-3-0", CG: "S-1-3-1", OW: "S-1-3-4", NU: "S-1-5-2", IU: "S-1-5-4", SU: "S-1-5-6",
  AN: "S-1-5-7", ED: "S-1-5-9", PS: "S-1-5-10", AU: "S-1-5-11", RC: "S-1-5-12", WR: "S-1-5-33", SY: "S-1-5-18",
  LS: "S-1-5-19", NS: "S-1-5-20", BA: "S-1-5-32-544", BU: "S-1-5-32-545", BG: "S-1-5-32-546", PU: "S-1-5-32-547",
  AO: "S-1-5-32-548", SO: "S-1-5-32-549", PO: "S-1-5-32-550", BO: "S-1-5-32-551", RE: "S-1-5-32-552",
  RU: "S-1-5-32-554", RD: "S-1-5-32-555", NO: "S-1-5-32-556", MU: "S-1-5-32-558", LU: "S-1-5-32-559",
  IS: "S-1-5-32-568", CY: "S-1-5-32-569", ER: "S-1-5-32-573", RA: "S-1-5-32-575", RM: "S-1-5-32-580",
  HA: "S-1-5-32-578", AC: "S-1-15-2-1", LW: "S-1-16-4096", ME: "S-1-16-8192", MP: "S-1-16-8448",
  HI: "S-1-16-12288", SI: "S-1-16-16384", AS: "S-1-18-1", SS: "S-1-18-2",
};

/** `alias` as a SID string; a SID or an unknown (domain-relative) alias is returned upper-cased as is. */
export const resolveSid = (alias: string): string => SID_ALIASES[alias.toUpperCase()] ?? alias.toUpperCase();

export type Ace = {
  /** `A` allow, `D` deny, `OA`/`OD` object, `XA`/`XD`/`ZA` callback, ... */
  readonly type: string;
  /** Inheritance flags such as `OI`, `CI`, `IO`, `ID`, `NP`. */
  readonly flags: readonly string[];
  readonly rights: string;
  /** The trustee, aliases resolved. */
  readonly sid: string;
};

export type Dacl = {
  /** `P` protected, `AI` auto-inherited, `AR` inheritance required. */
  readonly flags: readonly string[];
  /** A null DACL (`NO_ACCESS_CONTROL`): everyone has full access. */
  readonly nullDacl: boolean;
  readonly aces: readonly Ace[];
};

export type ParsedSddl = { readonly owner?: string; readonly group?: string; readonly dacl?: Dacl };

/** Splits the top level of `sddl` into its `O:`, `G:`, `D:` and `S:` parts (markers inside ACE parentheses are not split). */
const sections = (sddl: string): Map<string, string> => {
  const out = new Map<string, string>();
  let depth = 0;
  let key: string | undefined;
  let start = 0;
  for (let i = 0; i < sddl.length; i++) {
    const c = sddl[i]!;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && sddl[i + 1] === ":" && "OGDS".includes(c)) {
      if (key) out.set(key, sddl.slice(start, i));
      key = c;
      start = i + 2;
      i++;
    }
  }
  if (key) out.set(key, sddl.slice(start));
  return out;
};

/** The ACE strings of an ACL body, parentheses stripped (nested parentheses in conditional ACEs kept). */
const aceStrings = (body: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (body[i] === ")") {
      depth--;
      if (depth === 0) out.push(body.slice(start, i));
    }
  }
  return out;
};

const pairs = (text: string): string[] => text.match(/.{1,2}/g) ?? [];

const parseAce = (text: string): Ace => {
  const [type = "", flags = "", rights = "", , , sid = ""] = text.split(";");
  return { type: type.toUpperCase(), flags: pairs(flags.toUpperCase()), rights, sid: resolveSid(sid.trim()) };
};

const parseDacl = (text: string): Dacl => {
  const at = text.indexOf("(");
  const head = (at < 0 ? text : text.slice(0, at)).toUpperCase();
  const nullDacl = head.includes("NO_ACCESS_CONTROL");
  const flags = nullDacl ? [] : head.match(/AI|AR|P/g) ?? [];
  return { flags, nullDacl, aces: at < 0 ? [] : aceStrings(text.slice(at)).map(parseAce) };
};

/** Parses an SDDL string: owner and group with aliases resolved, and the DACL with its flags and ACEs. */
export const parseSddl = (sddl: string): ParsedSddl => {
  const parts = sections(sddl.trim());
  const owner = parts.get("O");
  const group = parts.get("G");
  const dacl = parts.get("D");
  return {
    ...(owner ? { owner: resolveSid(owner.trim()) } : {}),
    ...(group ? { group: resolveSid(group.trim()) } : {}),
    ...(dacl !== undefined ? { dacl: parseDacl(dacl) } : {}),
  };
};

const ALLOW_TYPES: ReadonlySet<string> = new Set(["A", "OA", "XA", "ZA"]);

/**
 * The runner directory's policy for one entry. The owner must be `userSid` (an Administrators owner means the entry was
 * made from an elevated shell and fails as `owner`); the DACL must exist, be protected (`D:P`) when `root` is set, and
 * hold allow ACEs only for the user, SYSTEM and Administrators, plus CREATOR OWNER when inherit-only. Deny ACEs are
 * fine. Returns undefined when the entry is safe.
 */
export const evaluateSddl = (sddl: string, userSid: string, options: { readonly root?: boolean } = {}): AclVerdict | undefined => {
  const parsed = parseSddl(sddl);
  const user = userSid.toUpperCase();
  if (parsed.owner !== user) return { reason: "owner", detail: `owner=${parsed.owner ?? "none"}` };
  const dacl = parsed.dacl;
  if (!dacl) return { reason: "acl", detail: "dacl=none" };
  if (dacl.nullDacl) return { reason: "acl", detail: "dacl=null" };
  if (options.root && !dacl.flags.includes("P")) return { reason: "acl", detail: "dacl=unprotected" };
  for (const ace of dacl.aces) {
    if (!ALLOW_TYPES.has(ace.type)) continue;
    if (ace.sid === user || ace.sid === SYSTEM_SID || ace.sid === ADMINISTRATORS_SID) continue;
    if (ace.sid === CREATOR_OWNER_SID && ace.flags.includes("IO")) continue;
    return { reason: "acl", detail: `allow=${ace.sid}` };
  }
  return undefined;
};

/** The SID in `whoami /user /fo csv /nh` output (`"host\user","S-1-5-21-..."`), or undefined. */
export const parseWhoamiUser = (output: string): string | undefined => output.match(/"(S-1-[0-9-]+)"/i)?.[1]?.toUpperCase();

const SE_FILE_OBJECT = 1;
const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const SDDL_REVISION_1 = 1;
const READ_CONTROL = 0x20000;
const FILE_SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_ATTRIBUTE_TAG_INFO = 9;
const TOKEN_QUERY = 0x8;
const TOKEN_USER = 1;
const INVALID_HANDLE = 0xffffffffffffffffn;

type Win32 = ReturnType<typeof openWin32>;

const openWin32 = () => {
  const { dlopen } = require("bun:ffi") as typeof import("bun:ffi");
  const advapi = dlopen("advapi32.dll", {
    GetSecurityInfo: { args: ["u64", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: { args: ["ptr", "u32", "u32", "ptr", "ptr"], returns: "i32" },
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    ConvertSidToStringSidW: { args: ["ptr", "ptr"], returns: "i32" },
  });
  const kernel = dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "u64" },
    GetFileInformationByHandleEx: { args: ["u64", "u32", "ptr", "u32"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetCurrentProcess: { args: [], returns: "u64" },
    GetLastError: { args: [], returns: "u32" },
    LocalFree: { args: ["u64"], returns: "u64" },
  });
  return { ...advapi.symbols, ...kernel.symbols };
};

let win32: Win32 | undefined;
const api = (): Win32 => (win32 ??= openWin32());

const wide = (text: string): Buffer => Buffer.from(`${text}\0`, "utf16le");

/** Reads a NUL-terminated UTF-16 string at `address`. */
const readWide = (address: bigint): string => {
  const { read } = require("bun:ffi") as typeof import("bun:ffi");
  const units: number[] = [];
  for (let at = 0; ; at += 2) {
    const unit = read.u16(address, at);
    if (unit === 0) break;
    units.push(unit);
  }
  return String.fromCharCode(...units);
};

/**
 * Reads `path`'s owner and DACL as SDDL, and its reparse tag. The entry is opened with `FILE_FLAG_OPEN_REPARSE_POINT`,
 * so a symlink, junction or socket is read itself and never followed. Throws on a Win32 failure.
 */
export const readSddl = (path: string): AclInfo => {
  const w = api();
  const handle = w.CreateFileW(wide(path), READ_CONTROL, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null);
  if (handle === INVALID_HANDLE) throw new Error(`CreateFileW ${path} failed: ${w.GetLastError()}`);
  try {
    const tag = new Uint32Array(2);
    const reparseTag = w.GetFileInformationByHandleEx(handle, FILE_ATTRIBUTE_TAG_INFO, tag, 8) && (tag[0]! & FILE_ATTRIBUTE_REPARSE_POINT) ? tag[1]! : undefined;
    const descriptor = new BigUint64Array(1);
    const nothing = new BigUint64Array(1);
    const info = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    const status = w.GetSecurityInfo(handle, SE_FILE_OBJECT, info, nothing, nothing, nothing, nothing, descriptor);
    if (status !== 0) throw new Error(`GetSecurityInfo ${path} failed: ${status}`);
    try {
      const text = new BigUint64Array(1);
      if (!w.ConvertSecurityDescriptorToStringSecurityDescriptorW(ptrArg(descriptor[0]!), SDDL_REVISION_1, info, text, null)) {
        throw new Error(`ConvertSecurityDescriptorToStringSecurityDescriptorW ${path} failed: ${w.GetLastError()}`);
      }
      try {
        const sddl = readWide(text[0]!);
        return { owner: parseSddl(sddl).owner ?? "", sddl, ...(reparseTag !== undefined ? { reparseTag } : {}) };
      } finally {
        w.LocalFree(text[0]!);
      }
    } finally {
      w.LocalFree(descriptor[0]!);
    }
  } finally {
    w.CloseHandle(handle);
  }
};

/** A raw address as the `ptr` argument type bun:ffi declares. */
const ptrArg = (address: bigint): import("bun:ffi").Pointer => Number(address) as import("bun:ffi").Pointer;

/** The current process token's user SID through `GetTokenInformation(TokenUser)`. */
const tokenUserSid = (): string => {
  const w = api();
  const token = new BigUint64Array(1);
  if (!w.OpenProcessToken(w.GetCurrentProcess(), TOKEN_QUERY, token)) throw new Error(`OpenProcessToken failed: ${w.GetLastError()}`);
  try {
    const size = new Uint32Array(1);
    w.GetTokenInformation(token[0]!, TOKEN_USER, null, 0, size);
    const buffer = new BigUint64Array(Math.ceil(size[0]! / 8) || 1);
    if (!w.GetTokenInformation(token[0]!, TOKEN_USER, buffer, buffer.byteLength, size)) throw new Error(`GetTokenInformation failed: ${w.GetLastError()}`);
    const text = new BigUint64Array(1);
    if (!w.ConvertSidToStringSidW(ptrArg(buffer[0]!), text)) throw new Error(`ConvertSidToStringSidW failed: ${w.GetLastError()}`);
    try {
      return readWide(text[0]!).toUpperCase();
    } finally {
      w.LocalFree(text[0]!);
    }
  } finally {
    w.CloseHandle(token[0]!);
  }
};

const whoamiUserSid = (): string => {
  const proc = Bun.spawnSync(["whoami", "/user", "/fo", "csv", "/nh"], { stdout: "pipe", stderr: "pipe" });
  const sid = parseWhoamiUser(proc.stdout.toString());
  if (!sid) throw new Error(`whoami /user gave no SID (exit ${proc.exitCode})`);
  return sid;
};

export type UserSidDeps = { readonly token?: () => string; readonly whoami?: () => string };

let cachedSid: string | undefined;

/** The runner user's SID: the process token through FFI, else `whoami /user`. Cached when read with the default sources. */
export const currentUserSid = (deps: UserSidDeps = {}): string => {
  const defaults = !deps.token && !deps.whoami;
  if (defaults && cachedSid) return cachedSid;
  let sid: string;
  try {
    sid = (deps.token ?? tokenUserSid)();
  } catch {
    sid = (deps.whoami ?? whoamiUserSid)();
  }
  if (defaults) cachedSid = sid;
  return sid;
};
