import { Hono } from "hono";
import { z } from "zod";
import type { MemberActor } from "../../../../shared/contracts/actors.ts";
import type { Result } from "../../../../shared/contracts/result.ts";
import { IdentifierSchema, type ProjectId } from "../../../../shared/contracts/ids.ts";
import {
  authorizeOutlineRequest,
  type OutlineHttpSecurity,
  type OutlineProjectAuthorization,
} from "../middleware/outline-security.ts";
import { parseBoundedJson } from "../middleware/request-limits.ts";

type SafeConnection = Readonly<{
  connectorId: string;
  workspaceId: string;
  identityKind: "MEMBER" | "BOT";
  providerUserId: string;
  refreshStatus: "READY" | "REAUTHORIZATION_REQUIRED" | "REVOKED";
  expiresAt?: number;
}>;

export function createOutlineConnectorRoutes(
  dependencies: OutlineHttpSecurity &
    OutlineProjectAuthorization &
    Readonly<{
      begin(
        actor: MemberActor,
        input: Readonly<Record<string, unknown>>,
      ): Promise<Result<Readonly<{ authorizationUrl: string }>>>;
      finish(
        actor: MemberActor,
        input: Readonly<Record<string, unknown>>,
      ): Promise<Result<SafeConnection>>;
      revoke(
        actor: MemberActor,
        input: Readonly<Record<string, unknown>>,
      ): Promise<Result<Readonly<{ revoked: true }>>>;
    }>,
): Hono {
  const app = new Hono();
  for (const [path, operation] of [
    ["/oauth/begin", dependencies.begin],
    ["/oauth/callback", dependencies.finish],
    ["/revoke", dependencies.revoke],
  ] as const) {
    app.post(path, async (context) => {
      const actor = await authorizeOutlineRequest(context, dependencies, true);
      if (actor instanceof Response) return actor;
      const input = await parseBoundedJson(
        context,
        z.object({ projectId: IdentifierSchema }).catchall(z.unknown()),
      );
      if (input instanceof Response) return input;
      const project = await dependencies.authorizeProject(actor, input.projectId as ProjectId);
      if (!project.ok) return context.json(project, 403);
      const result = await operation(actor, input);
      context.header("Cache-Control", "no-store");
      return context.json(result, result.ok ? 200 : 403);
    });
  }
  return app;
}
