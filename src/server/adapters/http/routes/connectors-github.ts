import { Hono } from "hono";
import type { Result } from "../../../../shared/contracts/result.ts";
import {
  consumeVerifiedGitHubWebhook,
  type EphemeralVerifiedGitHubDelivery,
  type WebhookReceipt,
} from "../../github/webhooks.ts";

export type GitHubWebhookRouteDependencies = Readonly<{
  webhookSecret(connectorId: string): Promise<Result<Uint8Array>>;
  consume(connectorId: string, delivery: EphemeralVerifiedGitHubDelivery): Promise<Result<WebhookReceipt>>;
  maxBodyBytes: number;
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
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(connectorId)) return context.json({ error: { code: "CONNECTOR_ID_INVALID", message: "Connector identifier is invalid." } }, 400);
    const secret = await dependencies.webhookSecret(connectorId);
    if (!secret.ok) return context.json({ error: secret.error }, 503);
    const result = await consumeVerifiedGitHubWebhook(context.req.raw, secret.value, { maxBodyBytes: dependencies.maxBodyBytes }, (delivery) => dependencies.consume(connectorId, delivery));
    return result.ok ? context.json(result.value, result.value.disposition === "REPLAY" ? 200 : 202) : context.json({ error: result.error }, status(result.error.code));
  });
  return app;
}
