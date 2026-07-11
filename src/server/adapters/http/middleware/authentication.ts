import type { MemberActor } from "../../../../shared/contracts/actors.ts";
import type { Result } from "../../../../shared/contracts/result.ts";

export interface PublicAuthenticationPort {
  authenticateBrowser(request: Request): Promise<Result<MemberActor>>;
  authenticateDevice(request: Request): Promise<Result<MemberActor>>;
  verifyBrowserMutation(request: Request, actor: MemberActor): boolean;
}

export async function authenticatePublicRequest(
  request: Request,
  authentication: PublicAuthenticationPort,
): Promise<Result<Readonly<{ actor: MemberActor; browser: boolean }>>> {
  const browser = request.headers.has("cookie") || request.headers.has("origin");
  const authenticated = browser
    ? await authentication.authenticateBrowser(request)
    : await authentication.authenticateDevice(request);
  return authenticated.ok
    ? { ok: true, value: { actor: authenticated.value, browser } }
    : authenticated;
}
