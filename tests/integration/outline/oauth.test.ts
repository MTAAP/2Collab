import { expect, test } from "bun:test";
import {
  createOutlineOAuth,
  type OutlineOAuthTransactionStore,
} from "../../../src/server/adapters/outline/oauth.ts";
import { createOutlineConnectorRoutes } from "../../../src/server/adapters/http/routes/connectors-outline.ts";
import { StrictOutlineOAuthProvider } from "../../fixtures/outline/strict-outline-adapter.ts";

function store(): OutlineOAuthTransactionStore {
  type StoredTransaction = Parameters<OutlineOAuthTransactionStore["save"]>[0];
  const entries = new Map<string, StoredTransaction>();
  return {
    async save(transaction) {
      entries.set(transaction.id, transaction);
      return { ok: true, value: { saved: true } };
    },
    async consume(id, stateHash, now) {
      const transaction = entries.get(id);
      entries.delete(id);
      if (!transaction || transaction.stateHash !== stateHash || transaction.expiresAt < now)
        return {
          ok: false,
          error: {
            code: "OUTLINE_OAUTH_TRANSACTION_INVALID",
            message: "Outline OAuth transaction is invalid.",
            retry: "NEVER",
          },
        };
      return { ok: true, value: transaction };
    },
  };
}

test("binds OAuth callback to state, member, session, redirect, connector, and epoch", async () => {
  const oauth = createOutlineOAuth({
    provider: new StrictOutlineOAuthProvider(),
    transactions: store(),
    clock: () => 1_000,
    id: () => "transaction_1",
    random: (() => {
      const values = ["v".repeat(43), "s".repeat(43)];
      return () => values.shift() ?? "x".repeat(43);
    })(),
  });
  const begun = await oauth.begin({
    connectorId: "connector_1",
    connectorEpoch: 1,
    memberId: "member_1",
    sessionId: "session_1",
    redirectOrigin: "https://collab.test",
    scopes: ["read", "write"],
  });
  expect(begun.ok).toBe(true);
  if (!begun.ok) return;
  const swapped = await oauth.finish({
    transactionId: begun.value.transactionId,
    state: begun.value.state,
    authorizationCode: "code",
    connectorId: "connector_1",
    connectorEpoch: 1,
    memberId: "member_2",
    sessionId: "session_1",
    redirectOrigin: "https://collab.test",
  });
  expect(swapped.ok).toBe(false);
  if (!swapped.ok) expect(swapped.error.code).toBe("OUTLINE_OAUTH_BINDING_INVALID");
  const replay = await oauth.finish({
    transactionId: begun.value.transactionId,
    state: begun.value.state,
    authorizationCode: "code",
    connectorId: "connector_1",
    connectorEpoch: 1,
    memberId: "member_1",
    sessionId: "session_1",
    redirectOrigin: "https://collab.test",
  });
  expect(replay.ok).toBe(false);
});

test("exposes safe identity health without returning provider tokens", async () => {
  const app = createOutlineConnectorRoutes({
    async begin() {
      return { ok: true, value: { authorizationUrl: "https://outline.test/oauth/authorize" } };
    },
    async finish() {
      return {
        ok: true,
        value: {
          connectorId: "connector_1",
          workspaceId: "workspace_1",
          identityKind: "MEMBER",
          providerUserId: "provider_member_1",
          refreshStatus: "READY",
          expiresAt: 10_000,
        },
      };
    },
    async revoke() {
      return { ok: true, value: { revoked: true } };
    },
  });
  const response = await app.request("/oauth/callback", { method: "POST" });
  const body = await response.text();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body).not.toContain("accessToken");
  expect(body).not.toContain("refreshToken");
  expect(body).toContain("provider_member_1");
});
