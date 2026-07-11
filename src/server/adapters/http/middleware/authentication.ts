import type { MemberActor } from "../../../../shared/contracts/actors.ts";
import type { Result } from "../../../../shared/contracts/result.ts";

export interface PublicAuthenticationPort {
  authenticateBrowser(request: Request): Promise<Result<MemberActor>>;
  authenticateDevice(request: Request): Promise<Result<MemberActor>>;
  verifyBrowserMutation(request: Request, actor: MemberActor): boolean;
}

function authenticationError(code: "AUTH_MODE_CONFLICT" | "DEVICE_AUTHENTICATION_REQUIRED") {
  return {
    ok: false as const,
    error: {
      code,
      message:
        code === "AUTH_MODE_CONFLICT"
          ? "Browser and device authentication cannot be combined."
          : "Device authentication is required.",
      retry: "NEVER" as const,
    },
  };
}

export async function authenticatePublicRequest(
  request: Request,
  authentication: PublicAuthenticationPort,
): Promise<Result<Readonly<{ actor: MemberActor; browser: boolean }>>> {
  const browser =
    request.headers.has("cookie") ||
    request.headers.has("origin") ||
    request.headers.has("sec-fetch-site");
  const device =
    request.headers.has("authorization") ||
    request.headers.has("dpop") ||
    request.headers.has("dpop-nonce");
  if (browser && device) return authenticationError("AUTH_MODE_CONFLICT");
  if (!browser && !device) return authenticationError("DEVICE_AUTHENTICATION_REQUIRED");
  const authenticated = browser
    ? await authentication.authenticateBrowser(request)
    : await authentication.authenticateDevice(request);
  return authenticated.ok
    ? { ok: true, value: { actor: authenticated.value, browser } }
    : authenticated;
}
