import { describe, expect, test } from "bun:test";
import { currentUserSid, evaluateSddl, parseSddl, parseWhoamiUser, resolveSid } from "../src/runner/win-acl.ts";

const USER = "S-1-5-21-3623811015-3361044348-30300820-1013";
const OTHER = "S-1-5-21-3623811015-3361044348-30300820-1014";
const GROUP = "S-1-5-21-3623811015-3361044348-30300820-513";

/** What `icacls /inheritance:r /grant:r` plus `/setowner` leaves on the runner root. */
const PROTECTED_ROOT = `O:${USER}G:${GROUP}D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
/** A child of that root: the same ACEs, inherited. */
const INHERITED_CHILD = `O:${USER}G:${GROUP}D:AI(A;OICIID;FA;;;${USER})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)`;
/** A fresh folder under the profile before the installer runs, as `Get-Acl` shows it. */
const PROFILE_DEFAULT = `O:${USER}G:${GROUP}D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`;

describe("parseSddl", () => {
  test("owner, group and protected DACL with aliases resolved", () => {
    const parsed = parseSddl(PROTECTED_ROOT);
    expect(parsed.owner).toBe(USER);
    expect(parsed.group).toBe(GROUP);
    expect(parsed.dacl?.flags).toEqual(["P", "AI"]);
    expect(parsed.dacl?.aces.map((a) => a.sid)).toEqual([USER, "S-1-5-18", "S-1-5-32-544"]);
    expect(parsed.dacl?.aces[0]).toEqual({ type: "A", flags: ["OI", "CI"], rights: "FA", sid: USER });
  });

  test("alias owner and group next to section markers", () => {
    const parsed = parseSddl("O:BAG:SYD:(A;;GA;;;SY)");
    expect(parsed.owner).toBe("S-1-5-32-544");
    expect(parsed.group).toBe("S-1-5-18");
    expect(parsed.dacl?.flags).toEqual([]);
    expect(parsed.dacl?.aces).toHaveLength(1);
  });

  test("a SACL after the DACL and hex rights masks", () => {
    const parsed = parseSddl(`O:${USER}D:P(A;;0x1200a9;;;WD)(D;OICI;GW;;;AN)S:AI(ML;;NW;;;ME)`);
    expect(parsed.dacl?.aces.map((a) => [a.type, a.rights, a.sid])).toEqual([["A", "0x1200a9", "S-1-1-0"], ["D", "GW", "S-1-5-7"]]);
  });

  test("conditional ACEs keep their nested parentheses inside one ACE", () => {
    const parsed = parseSddl(`O:${USER}D:P(XA;;FX;;;WD;(@User.Title=="PM" && (@User.Division=="x")))(A;;FA;;;${USER})`);
    expect(parsed.dacl?.aces.map((a) => [a.type, a.sid])).toEqual([["XA", "S-1-1-0"], ["A", USER]]);
  });

  test("well-known aliases", () => {
    expect(["SY", "BA", "WD", "AU", "BU", "CO", "AC", "ba"].map(resolveSid)).toEqual([
      "S-1-5-18", "S-1-5-32-544", "S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-3-0", "S-1-15-2-1", "S-1-5-32-544",
    ]);
    expect(resolveSid("LA")).toBe("LA");
    expect(resolveSid("s-1-5-18")).toBe("S-1-5-18");
  });

  test("null DACL and missing DACL", () => {
    expect(parseSddl(`O:${USER}D:NO_ACCESS_CONTROL`).dacl).toEqual({ flags: [], nullDacl: true, aces: [] });
    expect(parseSddl(`O:${USER}G:${GROUP}`).dacl).toBeUndefined();
  });
});

describe("evaluateSddl", () => {
  test("protected owner-only root passes; inherited child passes but not as root", () => {
    expect(evaluateSddl(PROTECTED_ROOT, USER, { root: true })).toBeUndefined();
    expect(evaluateSddl(INHERITED_CHILD, USER)).toBeUndefined();
    expect(evaluateSddl(INHERITED_CHILD, USER, { root: true })).toEqual({ reason: "acl", detail: "dacl=unprotected" });
    expect(evaluateSddl(PROFILE_DEFAULT, USER, { root: true })).toEqual({ reason: "acl", detail: "dacl=unprotected" });
  });

  test("user SID comparison ignores case", () => {
    expect(evaluateSddl(PROTECTED_ROOT, USER.toLowerCase(), { root: true })).toBeUndefined();
  });

  test("Administrators or another user as owner fails as owner", () => {
    expect(evaluateSddl(PROTECTED_ROOT.replace(`O:${USER}`, "O:BA"), USER)).toEqual({ reason: "owner", detail: "owner=S-1-5-32-544" });
    expect(evaluateSddl(PROTECTED_ROOT.replace(`O:${USER}`, `O:${OTHER}`), USER)).toEqual({ reason: "owner", detail: `owner=${OTHER}` });
    expect(evaluateSddl("D:P(A;;FA;;;SY)", USER)).toEqual({ reason: "owner", detail: "owner=none" });
  });

  test("allow ACEs for Everyone, Users, Authenticated Users, another user or an AppContainer fail as acl", () => {
    const cases: [string, string][] = [
      ["(A;;0x1200a9;;;WD)", "S-1-1-0"],
      ["(A;OICIID;GR;;;BU)", "S-1-5-32-545"],
      ["(A;ID;0x1301bf;;;AU)", "S-1-5-11"],
      [`(A;OICI;FA;;;${OTHER})`, OTHER],
      ["(A;OICI;0x1200a9;;;S-1-15-2-1)", "S-1-15-2-1"],
      ["(OA;;RP;bf967a7f-0de6-11d0-a285-00aa003049e2;;WD)", "S-1-1-0"],
      ["(XA;;FX;;;WD;(@User.Title==\"PM\"))", "S-1-1-0"],
    ];
    for (const [ace, sid] of cases) {
      expect(evaluateSddl(`${PROTECTED_ROOT}${ace}`, USER, { root: true })).toEqual({ reason: "acl", detail: `allow=${sid}` });
    }
  });

  test("CREATOR OWNER only as inherit-only; deny ACEs and SACLs are fine", () => {
    expect(evaluateSddl(`${PROTECTED_ROOT}(A;OICIIO;GA;;;CO)`, USER, { root: true })).toBeUndefined();
    expect(evaluateSddl(`${PROTECTED_ROOT}(A;;FA;;;CO)`, USER, { root: true })).toEqual({ reason: "acl", detail: "allow=S-1-3-0" });
    expect(evaluateSddl(`${PROTECTED_ROOT}(D;OICI;FA;;;WD)S:(ML;;NW;;;ME)`, USER, { root: true })).toBeUndefined();
  });

  test("null or missing DACL fails as acl", () => {
    expect(evaluateSddl(`O:${USER}D:NO_ACCESS_CONTROL`, USER)).toEqual({ reason: "acl", detail: "dacl=null" });
    expect(evaluateSddl(`O:${USER}G:${GROUP}`, USER)).toEqual({ reason: "acl", detail: "dacl=none" });
  });
});

describe("current user SID", () => {
  test("whoami csv output", () => {
    expect(parseWhoamiUser(`"desktop-1\\dori","${USER}"\r\n`)).toBe(USER);
    expect(parseWhoamiUser("ERROR: access denied")).toBeUndefined();
  });

  test("the token is preferred; whoami is the fallback", () => {
    const whoami = () => "S-1-5-21-9-9-9-1000";
    expect(currentUserSid({ token: () => USER, whoami })).toBe(USER);
    expect(currentUserSid({ token: () => { throw new Error("no advapi32"); }, whoami })).toBe("S-1-5-21-9-9-9-1000");
  });
});
