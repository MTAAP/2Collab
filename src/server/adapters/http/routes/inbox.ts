import { Hono, type Context } from "hono";
import type { MemberActor } from "../../../../shared/contracts/actors.ts";
import type { Result } from "../../../../shared/contracts/result.ts";
import type { CommandCenterLane } from "../../../modules/inbox/command-center.ts";
import type { InboxItem } from "../../../modules/inbox/inbox.ts";
import {
  authenticatePublicRequest,
  type PublicAuthenticationPort,
} from "../middleware/authentication.ts";
import { enforceRateLimit, type PublicRateLimitPort } from "../middleware/request-limits.ts";

type Card = Readonly<{
  subjectKey: string;
  summary: string;
  lane: CommandCenterLane;
  draggable: false;
}>;
export function createInboxRoutes(
  dependencies: Readonly<{
    authentication: PublicAuthenticationPort;
    rateLimits: PublicRateLimitPort;
    listInbox(actor: MemberActor): Promise<Result<readonly InboxItem[]>>;
    listCommandCenter(actor: MemberActor): Promise<Result<readonly Card[]>>;
  }>,
): Hono {
  const app = new Hono();
  const authenticate = async (context: Context) => {
    const result = await authenticatePublicRequest(context.req.raw, dependencies.authentication);
    if (!result.ok) return { response: context.json(result, 401) } as const;
    const limited = enforceRateLimit(context, dependencies.rateLimits, result.value.actor.memberId);
    return limited ? ({ response: limited } as const) : ({ actor: result.value.actor } as const);
  };
  app.get("/api/v1/inbox", async (context) => {
    const authenticated = await authenticate(context);
    if ("response" in authenticated) return authenticated.response;
    const result = await dependencies.listInbox(authenticated.actor);
    return context.json(result, result.ok ? 200 : 403);
  });
  app.get("/api/v1/command-center", async (context) => {
    const authenticated = await authenticate(context);
    if ("response" in authenticated) return authenticated.response;
    const result = await dependencies.listCommandCenter(authenticated.actor);
    return context.json(result, result.ok ? 200 : 403);
  });
  return app;
}
