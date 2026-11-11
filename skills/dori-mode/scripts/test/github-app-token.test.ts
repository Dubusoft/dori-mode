import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { GithubMintError, mintInstallationToken } from "../src/github-app-token.ts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NOW = 1_800_000_000_000;
const TOKEN = "dori-test-throwaway-123";
const PERMS = { contents: "write", pull_requests: "read" };

interface Seen { url: string; init: RequestInit }
const fakeFetch = (respond: () => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } => {
  const seen: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fetch: f, seen };
};
const mint = (f: typeof fetch) =>
  mintInstallationToken({ appId: "12345", installationId: "678", privateKeyPem: pem, repo: "acme/dori-mode", permissions: PERMS, fetch: f, now: () => NOW });
const jwtOf = (init: RequestInit): string => String((init.headers as Record<string, string>).Authorization).replace("Bearer ", "");

describe("mintInstallationToken", () => {
  test("sends a signed RS256 JWT and the scoped request, returns token and expiry", async () => {
    const { fetch: f, seen } = fakeFetch(() => Response.json({ token: TOKEN, expires_at: "2027-01-01T00:00:00Z" }, { status: 201 }));
    expect(await mint(f)).toEqual({ token: TOKEN, expiresAt: "2027-01-01T00:00:00Z" });
    expect(seen).toHaveLength(1);
    const { url, init } = seen[0]!;
    expect(url).toBe("https://api.github.com/app/installations/678/access_tokens");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(JSON.parse(String(init.body))).toEqual({ repositories: ["dori-mode"], permissions: PERMS });

    const [h, c, s] = jwtOf(init).split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(c, "base64url").toString()) as { iss: string; iat: number; exp: number };
    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBe(Math.floor(NOW / 1000) - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.exp).toBeGreaterThan(claims.iat);
    const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });

  test("a 403 throws GithubMintError without JWT, PEM or token text", async () => {
    const { fetch: f, seen } = fakeFetch(() => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }));
    const err = await mint(f).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(GithubMintError);
    const msg = (err as Error).message;
    expect(msg.startsWith("GITHUB_MINT_FAILED 403")).toBe(true);
    expect(msg).toContain("Resource not accessible");
    expect(msg).not.toContain(jwtOf(seen[0]!.init));
    expect(msg).not.toContain("PRIVATE KEY");
    expect(msg).not.toContain(TOKEN);
  });

  test("a network error throws GithubMintError without leaking secrets", async () => {
    const { fetch: f } = fakeFetch(() => { throw new Error(`connect failed ${TOKEN} ${pem}`); });
    const err = await mint(f).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(GithubMintError);
    const msg = (err as Error).message;
    expect(msg.startsWith("GITHUB_MINT_FAILED")).toBe(true);
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toContain("PRIVATE KEY");
    expect(msg).not.toMatch(/eyJ/);
  });

  test("an unusable private key throws GithubMintError before any request", async () => {
    const { fetch: f, seen } = fakeFetch(() => Response.json({}, { status: 201 }));
    const err = await mintInstallationToken({ appId: "1", installationId: "2", privateKeyPem: "not a pem", repo: "a/b", permissions: PERMS, fetch: f, now: () => NOW })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(GithubMintError);
    expect(seen).toHaveLength(0);
  });
});
