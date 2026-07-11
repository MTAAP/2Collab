import { createPrivateKey, createSign } from "node:crypto";
import type { Result } from "../../../shared/contracts/result.ts";

const GITHUB_API_VERSION = "2022-11-28";

function failure(code: string, retry: "NEVER" | "SAME_INPUT" = "NEVER"): Result<never> {
  return { ok: false, error: { code, message: "GitHub App authentication failed.", retry } };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createGitHubAppJwt(input: Readonly<{ appId: string; privateKey: Uint8Array; now: number }>): Result<string> {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(input.appId) || !Number.isInteger(input.now) || input.now < 0) {
    return failure("GITHUB_APP_AUTH_INPUT_INVALID");
  }
  try {
    const header = encode({ alg: "RS256", typ: "JWT" });
    const payload = encode({ iat: Math.max(0, Math.floor(input.now / 1000) - 60), exp: Math.floor(input.now / 1000) + 540, iss: input.appId });
    const signingInput = `${header}.${payload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const key = createPrivateKey(Buffer.from(input.privateKey));
    return { ok: true, value: `${signingInput}.${signer.sign(key).toString("base64url")}` };
  } catch {
    return failure("GITHUB_APP_KEY_INVALID");
  }
}

export type InstallationToken = Readonly<{
  token: string;
  expiresAt: number;
  repositoryIds: readonly string[];
  permissions: Readonly<Record<string, "read" | "write">>;
}>;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function requestInstallationToken(input: Readonly<{
  appJwt: string;
  installationId: string;
  repositoryIds: readonly string[];
  permissions: Readonly<Record<string, "read" | "write">>;
  fetcher?: Fetcher;
}>): Promise<Result<InstallationToken>> {
  if (!/^[0-9]{1,32}$/.test(input.installationId) || input.repositoryIds.length > 500 || input.repositoryIds.some((id) => !/^[0-9]{1,32}$/.test(id))) {
    return failure("GITHUB_APP_AUTH_INPUT_INVALID");
  }
  try {
    const response = await (input.fetcher ?? fetch)(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.appJwt}`,
        "content-type": "application/json",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({ repository_ids: input.repositoryIds, permissions: input.permissions }),
    });
    if (!response.ok) return failure(response.status === 403 ? "GITHUB_APP_PERMISSION_DENIED" : "GITHUB_APP_TOKEN_UNAVAILABLE", "SAME_INPUT");
    const body = (await response.json()) as Record<string, unknown>;
    const token = body.token;
    const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
    if (typeof token !== "string" || token.length < 1 || token.length > 1_024 || !Number.isFinite(expiresAt)) return failure("GITHUB_APP_RESPONSE_INVALID");
    return { ok: true, value: { token, expiresAt, repositoryIds: [...input.repositoryIds], permissions: { ...input.permissions } } };
  } catch {
    return failure("GITHUB_APP_TOKEN_UNAVAILABLE", "SAME_INPUT");
  }
}

export class GitHubInstallationTokenCache {
  private cached: Readonly<{ key: string; value: InstallationToken }> | undefined;

  async get(input: Readonly<{
    connectorId: string;
    connectorEpoch: number;
    scopeDigest: string;
    permissionDigest: string;
    now: number;
    issue: () => Promise<Result<InstallationToken>>;
  }>): Promise<Result<InstallationToken>> {
    const key = `${input.connectorId}:${input.connectorEpoch}:${input.scopeDigest}:${input.permissionDigest}`;
    if (this.cached?.key === key && this.cached.value.expiresAt > input.now + 60_000) return { ok: true, value: this.cached.value };
    const issued = await input.issue();
    if (!issued.ok) return issued;
    this.cached = { key, value: issued.value };
    return issued;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}

export const GITHUB_REST_HEADERS = Object.freeze({
  accept: "application/vnd.github+json",
  "x-github-api-version": GITHUB_API_VERSION,
});
