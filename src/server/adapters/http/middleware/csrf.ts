import { createMiddleware } from "hono/factory";
import { verifyCsrf } from "../../../modules/identity/csrf.ts";
import type { BrowserSessionAccess } from "../../../modules/identity/sessions.ts";

export function createCsrfMiddleware(configuredOrigin: string) {
  return createMiddleware(async (context, next) => {
    const session = context.get("memberSession") as BrowserSessionAccess | undefined;
    const token = context.req.header("x-collab-csrf");
    if (
      !session ||
      !token ||
      !verifyCsrf(session.csrfHash, token, {
        origin: context.req.header("origin") ?? null,
        method: context.req.method,
        contentType: context.req.header("content-type") ?? null,
        configuredOrigin,
      })
    ) {
      return context.json(
        { error: { code: "CSRF_INVALID", message: "CSRF proof is invalid." } },
        403,
      );
    }
    await next();
  });
}
