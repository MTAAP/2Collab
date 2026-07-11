import { Hono } from "hono";
import type { Result } from "../../../../shared/contracts/result.ts";
import type { WebhookReceipt } from "../../../modules/github-coordination/contract.ts";

export type GitHubWebhookRouteDependencies = Readonly<{
  receive(connectorId: string, request: Request): Promise<Result<WebhookReceipt>>;
}>;

function status(code: string): 400 | 401 | 409 | 413 | 415 | 503 {
  if (code === "WEBHOOK_SIGNATURE_INVALID") return 401;
  if (code === "WEBHOOK_DELIVERY_CONFLICT") return 409;
  if (code === "WEBHOOK_BODY_TOO_LARGE") return 413;
  if (code === "WEBHOOK_ENCODING_UNSUPPORTED") return 415;
  if (code.endsWith("UNAVAILABLE") || code.endsWith("FAILED")) return 503;
  return 400;
}

export function createGitHubConnectorRoutes(dependencies: GitHubWebhookRouteDependencies): Hono {
  const app = new Hono();
  app.post("/api/v1/connectors/github/:connectorId/webhooks", async (context) => {
    const connectorId = context.req.param("connectorId");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(connectorId))
      return context.json(
        { error: { code: "CONNECTOR_ID_INVALID", message: "Connector identifier is invalid." } },
        400,
      );
    const result = await dependencies.receive(connectorId, context.req.raw);
    return result.ok
      ? context.json(result.value, result.value.disposition === "REPLAY" ? 200 : 202)
      : context.json({ error: result.error }, status(result.error.code));
  });
  return app;
}
