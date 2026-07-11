import type { VerifiedRunnerPrincipal } from "../../../shared/contracts/actors.ts";
import type { Result } from "../../../shared/contracts/result.ts";

export type AuthenticateRunnerUpgrade = Readonly<{
  accessToken: string;
  proof: string;
  nonce: string;
  method: "GET";
  uri: string;
}>;

export interface RunnerUpgradeAuthenticationAuthority {
  authenticateUpgrade(input: AuthenticateRunnerUpgrade): Promise<Result<VerifiedRunnerPrincipal>>;
}

type Dependencies = Readonly<{ authority: RunnerUpgradeAuthenticationAuthority }>;

function unauthorized(): Result<never> {
  return {
    ok: false,
    error: {
      code: "RUNNER_UPGRADE_UNAUTHORIZED",
      message: "Runner upgrade authentication failed.",
      retry: "NEVER",
    },
  };
}

function bounded(value: string | null, minimum: number, maximum: number): value is string {
  return value !== null && value.length >= minimum && value.length <= maximum;
}

export function createRunnerUpgradeAuthenticator(dependencies: Dependencies) {
  return async (
    request: Request,
    transport: Readonly<{ secureTransport: boolean }>,
  ): Promise<Result<VerifiedRunnerPrincipal>> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return unauthorized();
    }
    if (
      !transport.secureTransport ||
      request.method !== "GET" ||
      url.protocol !== "https:" ||
      url.pathname !== "/runner/v1" ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      request.headers.has("cookie") ||
      request.headers.has("sec-websocket-protocol")
    ) {
      return unauthorized();
    }
    const authorization = request.headers.get("authorization");
    const proof = request.headers.get("dpop");
    const nonce = request.headers.get("dpop-nonce");
    const authorizationMatch = /^DPoP ([A-Za-z0-9_-]{32,512})$/.exec(authorization ?? "");
    if (!authorizationMatch || !bounded(proof, 1, 8_192) || !bounded(nonce, 1, 512)) {
      return unauthorized();
    }
    try {
      const result = await dependencies.authority.authenticateUpgrade({
        accessToken: authorizationMatch[1],
        proof,
        nonce,
        method: "GET",
        uri: url.toString(),
      });
      return result.ok ? result : unauthorized();
    } catch {
      return unauthorized();
    }
  };
}
