import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import {
  consumeVerifiedGitHubWebhook,
  recordVerifiedGitHubDelivery,
} from "../../../src/server/adapters/github/webhooks.ts";

const secret = new TextEncoder().encode("a sufficiently long webhook secret");

function signedRequest(body: string, deliveryId = "delivery-1", extra: HeadersInit = {}): Request {
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return new Request("https://collab.test/api/v1/connectors/github/github_1/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-hook-id": "hook-1",
      "x-github-delivery": deliveryId,
      "x-github-event": "issues",
      "x-hub-signature-256": `sha256=${signature}`,
      ...extra,
    },
    body,
  });
}

function database(): Database {
  const db = new Database(":memory:", { strict: true });
  migrate(db);
  db.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_1', 1, 'team_1', 1, 0);
    INSERT INTO projects(id, team_id, name, base_branch, revision, created_at) VALUES ('project_1', 'team_1', 'Project', 'main', 1, 0);
    INSERT INTO connector_epochs(connector_id, epoch, review_state) VALUES ('github_1', 1, 'READY');
    INSERT INTO encrypted_credentials(id, credential_class, owner_kind, owner_id, connector_id, credential_owner_id, key_id, key_version, algorithm, nonce, ciphertext, auth_tag, revision, created_at, updated_at)
      VALUES ('private_1', 'PROVIDER', 'CONNECTOR', 'github_1', 'github_1', 'private', 'key_1', 1, 'AES_256_GCM', zeroblob(12), X'01', zeroblob(16), 1, 0, 0),
             ('secret_1', 'PROVIDER', 'CONNECTOR', 'github_1', 'github_1', 'webhook', 'key_1', 1, 'AES_256_GCM', zeroblob(12), X'02', zeroblob(16), 1, 0, 0);
    INSERT INTO github_installations(connector_id, app_id, installation_id, account_id, account_node_id, account_login, private_key_credential_id, webhook_secret_credential_id, revision, created_at, updated_at)
      VALUES ('github_1', '1', '2', '3', 'O_3', 'org', 'private_1', 'secret_1', 1, 0, 0);
    INSERT INTO github_project_connectors(project_id, connector_id, revision, created_at) VALUES ('project_1', 'github_1', 1, 0);
  `);
  return db;
}

describe("signed GitHub webhook ingestion", () => {
  test("verifies before durable deduplication and rejects changed-digest replay", async () => {
    const db = database();
    const consume = (request: Request) => consumeVerifiedGitHubWebhook(request, secret, { maxBodyBytes: 1024 }, async (delivery) => recordVerifiedGitHubDelivery({ database: db, connectorId: "github_1", projectIds: ["project_1"], delivery, receivedAt: 10 }));
    const first = await consume(signedRequest('{"action":"opened"}'));
    const replay = await consume(signedRequest('{"action":"opened"}'));
    const conflict = await consume(signedRequest('{"action":"closed"}'));
    expect(first).toMatchObject({ ok: true, value: { disposition: "PENDING" } });
    expect(replay).toMatchObject({ ok: true, value: { disposition: "REPLAY" } });
    expect(conflict).toMatchObject({ ok: false, error: { code: "WEBHOOK_DELIVERY_CONFLICT" } });
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM github_webhook_deliveries").get()).toEqual({ count: 1 });
    db.close();
  });

  test("rejects invalid signatures and chunked overflow before consumer invocation", async () => {
    let consumed = 0;
    const invalid = signedRequest("{}", "delivery-2", { "x-hub-signature-256": `sha256=${"0".repeat(64)}` });
    expect(await consumeVerifiedGitHubWebhook(invalid, secret, { maxBodyBytes: 8 }, async () => { consumed += 1; throw new Error("unreachable"); })).toMatchObject({ ok: false, error: { code: "WEBHOOK_SIGNATURE_INVALID" } });
    const overflow = signedRequest('{"long":"payload"}', "delivery-3");
    expect(await consumeVerifiedGitHubWebhook(overflow, secret, { maxBodyBytes: 8 }, async () => { consumed += 1; throw new Error("unreachable"); })).toMatchObject({ ok: false, error: { code: "WEBHOOK_BODY_TOO_LARGE" } });
    expect(consumed).toBe(0);
  });
});
