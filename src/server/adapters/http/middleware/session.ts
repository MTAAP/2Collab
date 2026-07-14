import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Result } from "../../../../shared/contracts/result.ts";
import type { BrowserSessionAccess } from "../../../modules/identity/sessions.ts";

export type SessionVerifier = Readonly<{
  verifyCookie(
    input: Readonly<{ sessionId: string; sessionProof: string }>,
  ): Promise<Result<BrowserSessionAccess>>;
}>;

export function createSessionMiddleware(verifier: SessionVerifier) {
  return createMiddleware(async (context, next) => {
    const cookie = getCookie(context, "collab_session");
    const separator = cookie?.indexOf(".") ?? -1;
    const sessionId = separator > 0 ? cookie?.slice(0, separator) : undefined;
    const sessionProof = separator > 0 ? cookie?.slice(separator + 1) : undefined;
    if (!sessionId || !sessionProof) {
      return context.json(
        { error: { code: "SESSION_REQUIRED", message: "Member session is required." } },
        401,
      );
    }
    const verified = await verifier.verifyCookie({ sessionId, sessionProof });
    if (!verified.ok) {
      return context.json(
        { error: { code: verified.error.code, message: verified.error.message } },
        401,
      );
    }
    context.set("memberSession", verified.value);
    await next();
  });
}
