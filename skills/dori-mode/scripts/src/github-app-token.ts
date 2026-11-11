import { createSign } from "node:crypto";

/** Mint failure; the message starts with `GITHUB_MINT_FAILED` and never carries the JWT, the private key or a token. */
export class GithubMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubMintError";
  }
}

export interface MintInstallationTokenOptions {
  readonly appId: string;
  readonly installationId: string;
  /** PEM private key of the GitHub App. */
  readonly privateKeyPem: string;
  /** `owner/repo`; the token is restricted to the repo name part. */
  readonly repo: string;
  readonly permissions: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

const b64url = (input: string | Buffer): string => Buffer.from(input).toString("base64url");

/** RS256 App JWT: iat = now-60 (clock skew), exp = iat+540, so the lifetime stays under GitHub's 10 minute cap. */
const appJwt = (appId: string, privateKeyPem: string, nowMs: number): string => {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat, exp: iat + 600 - 60, iss: appId }))}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(privateKeyPem).toString("base64url")}`;
};

/** Mints a 1 h GitHub App installation token restricted to `repo` and `permissions`; throws `GithubMintError` on any failure. */
export const mintInstallationToken = async (opts: MintInstallationTokenOptions): Promise<{ token: string; expiresAt: string }> => {
  const doFetch = opts.fetch ?? globalThis.fetch;
  let jwt: string;
  try {
    jwt = appJwt(opts.appId, opts.privateKeyPem, (opts.now ?? Date.now)());
  } catch {
    throw new GithubMintError("GITHUB_MINT_FAILED sign: cannot sign the App JWT with the private key");
  }
  const name = opts.repo.split("/").pop() ?? opts.repo;
  let res: Response;
  try {
    res = await doFetch(`https://api.github.com/app/installations/${encodeURIComponent(opts.installationId)}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ repositories: [name], permissions: opts.permissions }),
    });
  } catch {
    throw new GithubMintError("GITHUB_MINT_FAILED network: request to api.github.com failed");
  }
  let json: { token?: unknown; expires_at?: unknown; message?: unknown } = {};
  try { json = (await res.json()) as typeof json; } catch { /* non-JSON body: status alone is reported */ }
  if (res.status !== 201) {
    const msg = typeof json.message === "string" ? json.message.split(jwt).join("[REDACTED]").slice(0, 200) : "";
    throw new GithubMintError(`GITHUB_MINT_FAILED ${res.status}: ${msg}`);
  }
  if (typeof json.token !== "string" || typeof json.expires_at !== "string") {
    throw new GithubMintError("GITHUB_MINT_FAILED 201: response lacks token or expires_at");
  }
  return { token: json.token, expiresAt: json.expires_at };
};
