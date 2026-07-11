import type { Database } from "bun:sqlite";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Result } from "../../../shared/contracts/result.ts";

const verifiedBody = Symbol("verifiedGitHubBody");

export type WebhookLimits = Readonly<{ maxBodyBytes: number }>;
export type EphemeralVerifiedGitHubDelivery = Readonly<{
  hookId: string;
  deliveryId: string;
  eventName: string;
  bodyDigest: string;
  [verifiedBody]: Uint8Array;
  json(): unknown;
  toJSON(): Readonly<{ hookId: string; deliveryId: string; eventName: string; bodyDigest: string }>;
}>;
export type WebhookReceipt = Readonly<{
  connectorId: string;
  hookId: string;
  deliveryId: string;
  disposition: "APPLIED" | "REPLAY" | "PENDING";
}>;

function failure(code: string, retry: "NEVER" | "SAME_INPUT" = "NEVER"): Result<never> {
  return { ok: false, error: { code, message: "GitHub webhook was rejected.", retry } };
}

function header(request: Request, name: string, maximum: number): Result<string> {
  const value = request.headers.get(name);
  return value && value.length <= maximum && /^[A-Za-z0-9_.:-]+$/.test(value)
    ? { ok: true, value }
    : failure("WEBHOOK_HEADER_INVALID");
}

async function boundedBody(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<Result<Uint8Array>> {
  if (!body) return { ok: true, value: new Uint8Array() };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (length > maximum) {
        await reader.cancel();
        return failure("WEBHOOK_BODY_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } catch {
    return failure("WEBHOOK_BODY_UNAVAILABLE", "SAME_INPUT");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return { ok: true, value: bytes };
}

export async function consumeVerifiedGitHubWebhook(
  request: Request,
  secret: Uint8Array,
  limits: WebhookLimits,
  consume: (delivery: EphemeralVerifiedGitHubDelivery) => Promise<Result<WebhookReceipt>>,
): Promise<Result<WebhookReceipt>> {
  if (limits.maxBodyBytes < 1 || limits.maxBodyBytes > 10 * 1024 * 1024 || secret.length < 16 || secret.length > 1_024) return failure("WEBHOOK_CONFIGURATION_INVALID");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" || request.headers.has("content-encoding")) return failure("WEBHOOK_ENCODING_UNSUPPORTED");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limits.maxBodyBytes)) return failure("WEBHOOK_BODY_TOO_LARGE");
  const hookId = header(request, "x-github-hook-id", 64); if (!hookId.ok) return hookId;
  const deliveryId = header(request, "x-github-delivery", 128); if (!deliveryId.ok) return deliveryId;
  const eventName = header(request, "x-github-event", 64); if (!eventName.ok) return eventName;
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return failure("WEBHOOK_SIGNATURE_INVALID");
  const body = await boundedBody(request.body, limits.maxBodyBytes); if (!body.ok) return body;
  const expected = createHmac("sha256", secret).update(body.value).digest();
  const supplied = Buffer.from(signature.slice(7), "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return failure("WEBHOOK_SIGNATURE_INVALID");
  const digest = createHash("sha256").update(body.value).digest("hex");
  const delivery: EphemeralVerifiedGitHubDelivery = Object.freeze({
    hookId: hookId.value,
    deliveryId: deliveryId.value,
    eventName: eventName.value,
    bodyDigest: digest,
    [verifiedBody]: body.value,
    json() { return JSON.parse(Buffer.from(body.value).toString("utf8")); },
    toJSON() { return { hookId: hookId.value, deliveryId: deliveryId.value, eventName: eventName.value, bodyDigest: digest }; },
  });
  try { return await consume(delivery); } catch { return failure("WEBHOOK_CONSUMER_FAILED", "SAME_INPUT"); }
}

export function recordVerifiedGitHubDelivery(input: Readonly<{
  database: Database;
  connectorId: string;
  projectIds: readonly string[];
  delivery: EphemeralVerifiedGitHubDelivery;
  receivedAt: number;
}>): Result<WebhookReceipt> {
  const existing = input.database.query<{ payload_digest: string; ingress_state: string }, [string, string, string]>(
    "SELECT payload_digest, ingress_state FROM github_webhook_deliveries WHERE connector_id = ? AND hook_id = ? AND delivery_id = ?",
  ).get(input.connectorId, input.delivery.hookId, input.delivery.deliveryId);
  if (existing && existing.payload_digest !== input.delivery.bodyDigest) {
    input.database.query("UPDATE github_webhook_deliveries SET ingress_state = 'CONFLICT' WHERE connector_id = ? AND hook_id = ? AND delivery_id = ?").run(input.connectorId, input.delivery.hookId, input.delivery.deliveryId);
    return failure("WEBHOOK_DELIVERY_CONFLICT");
  }
  if (existing?.ingress_state === "CONFLICT") return failure("WEBHOOK_DELIVERY_CONFLICT");
  if (existing) return { ok: true, value: { connectorId: input.connectorId, hookId: input.delivery.hookId, deliveryId: input.delivery.deliveryId, disposition: "REPLAY" } };
  try {
    input.database.transaction(() => {
      input.database.query(`INSERT INTO github_webhook_deliveries(connector_id, hook_id, delivery_id, event_name, payload_digest, ingress_state, received_at) VALUES (?, ?, ?, ?, ?, 'VERIFIED', ?)`).run(input.connectorId, input.delivery.hookId, input.delivery.deliveryId, input.delivery.eventName, input.delivery.bodyDigest, input.receivedAt);
      for (const projectId of input.projectIds) input.database.query(`INSERT INTO github_webhook_applications(connector_id, hook_id, delivery_id, project_id, outcome, revision) VALUES (?, ?, ?, ?, 'PENDING', 1)`).run(input.connectorId, input.delivery.hookId, input.delivery.deliveryId, projectId);
    })();
    return { ok: true, value: { connectorId: input.connectorId, hookId: input.delivery.hookId, deliveryId: input.delivery.deliveryId, disposition: "PENDING" } };
  } catch { return failure("WEBHOOK_STORAGE_FAILED", "SAME_INPUT"); }
}
