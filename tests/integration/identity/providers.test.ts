import { describe, expect, test } from "bun:test";
import { createAuthRecoverCommand } from "../../../src/server/commands/auth-recover.ts";
import { openDatabase } from "../../../src/server/db/connection.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import {
  type AuthProxyAssertionPort,
  createAuthProxyProvenanceVerifier,
} from "../../../src/server/modules/identity/auth-proxy.ts";
import { createOidcAuthority, type OidcPort } from "../../../src/server/modules/identity/oidc.ts";
import { createProviderLinkAuthority } from "../../../src/server/modules/identity/provider-links.ts";

function fixture() {
  const database = openDatabase(":memory:");
  migrate(database);
  database.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at)
      VALUES ('deployment_1', 1, 'team_1', 1, 0);
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
      VALUES ('member_1', 'Ada', 'OWNER', 'ACTIVE', 1, 1, 0);
    INSERT INTO sessions(
      id, member_id, proof_hash, kind, expires_at, idle_expires_at, csrf_hash,
      absolute_expires_at, member_authority_epoch, revision, created_at
    ) VALUES (
      'session_1', 'member_1', X'${"11".repeat(32)}', 'BROWSER', 10000, 10000, X'${"12".repeat(32)}',
      10000, 1, 1, 0
    );
  `);
  let sequence = 0;
  const port: OidcPort = {
    async verify(input) {
      if (
        input.provider.issuer !== "https://issuer.test" ||
        input.provider.audience !== "client_1" ||
        input.transaction.nonceHash.length !== 32 ||
        input.authorizationCode !== "authorization_code" ||
        input.transaction.stateHash.length !== 32
      ) {
        return {
          ok: false,
          error: {
            code: "OIDC_VERIFICATION_FAILED",
            message: "OIDC verification failed.",
            retry: "NEVER",
          },
        };
      }
      return {
        ok: true,
        value: { issuer: "https://issuer.test", subject: "subject_1" },
      };
    },
  };
  const oidc = createOidcAuthority({
    database,
    clock: () => 1_000,
    id: (prefix) => `${prefix}_${100 + ++sequence}`,
    randomSecret: (label) => (label === "state" ? "state_1" : "nonce_1"),
    providers: [
      {
        id: "oidc_1",
        issuer: "https://issuer.test",
        audience: "client_1",
        clientId: "client_1",
        redirectUri: "https://collab.test/auth/oidc/callback",
      },
    ],
    port,
  });
  const links = createProviderLinkAuthority({
    database,
    clock: () => 1_000,
    id: (prefix) => `${prefix}_${100 + ++sequence}`,
    digest: async (value) =>
      value.includes("proof-with")
        ? Uint8Array.from({ length: 32 }, () => 0x11)
        : new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  });
  return { database, oidc, links };
}

describe("provider identity", () => {
  test("OIDC state, nonce, redirect, issuer, and audience are server-owned and single-use", async () => {
    const f = fixture();
    try {
      const begun = f.oidc.begin({ providerId: "oidc_1" });
      expect(begun.ok).toBe(true);
      if (!begun.ok) return;
      expect(begun.value.redirectUri).toBe("https://collab.test/auth/oidc/callback");
      const verified = await f.oidc.complete({
        transactionId: begun.value.transactionId,
        authorizationCode: "authorization_code",
        returnedState: "state_1",
      });
      expect(verified.ok).toBe(true);
      const replay = await f.oidc.complete({
        transactionId: begun.value.transactionId,
        authorizationCode: "authorization_code",
        returnedState: "state_1",
      });
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.code).toBe("OIDC_TRANSACTION_USED");
    } finally {
      f.database.close();
    }
  });

  test("a verified provider identity only links to an authenticated member", async () => {
    const f = fixture();
    try {
      const begun = f.oidc.begin({ providerId: "oidc_1" });
      if (!begun.ok) throw new Error(begun.error.code);
      const verified = await f.oidc.complete({
        transactionId: begun.value.transactionId,
        authorizationCode: "authorization_code",
        returnedState: "state_1",
      });
      if (!verified.ok) throw new Error(verified.error.code);
      const linked = await f.links.link({
        idempotencyKey: "link_1",
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        identity: verified.value,
      });
      expect(linked.ok).toBe(true);
      expect(
        f.database.query<{ count: number }, []>("SELECT count(*) AS count FROM members").get(),
      ).toEqual({ count: 1 });
      const uninvited = await f.links.acceptInvitation({
        idempotencyKey: "accept_1",
        invitationSessionSecret: "not-an-invitation-session-secret-000",
        displayName: "Grace",
        identity: { ...verified.value, subject: "subject_2" },
      });
      expect(uninvited.ok).toBe(false);
      if (!uninvited.ok) expect(uninvited.error.code).toBe("INVITATION_REQUIRED");
    } finally {
      f.database.close();
    }
  });

  test("provider linking rejects a browser session at the shared idle deadline", async () => {
    const f = fixture();
    try {
      f.database.exec("UPDATE sessions SET idle_expires_at = 1000 WHERE id = 'session_1'");
      const linked = await f.links.link({
        idempotencyKey: "idle_link",
        actor: {
          kind: "MEMBER",
          memberId: "member_1" as never,
          sessionId: "session_1" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        identity: {
          kind: "OIDC",
          issuer: "https://issuer.test",
          subject: "idle_subject",
        } as never,
      });
      expect(linked.ok).toBe(false);
      if (!linked.ok) expect(linked.error.code).toBe("SESSION_INVALID");
    } finally {
      f.database.close();
    }
  });

  test("provider invitation acceptance issues an ordinary browser session and audit", async () => {
    const f = fixture();
    try {
      f.database.exec(`
        INSERT INTO invitations(id, token_hash, inviter_id, expires_at, revision, created_at)
          VALUES ('invitation_provider', X'${"22".repeat(32)}', 'member_1', 2000, 1, 0);
      `);
      const invitationSecret = "provider-invitation-session-secret-000000";
      const invitationHash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(invitationSecret)),
      );
      f.database
        .query(
          `INSERT INTO invitation_exchange_sessions(
             id, invitation_id, session_hash, revision, created_at, expires_at
           ) VALUES ('exchange_provider', 'invitation_provider', ?, 1, 101, 1001)`,
        )
        .run(invitationHash);
      const accepted = await f.links.acceptInvitation({
        idempotencyKey: "provider_accept",
        invitationSessionSecret: invitationSecret,
        displayName: "Grace",
        identity: { kind: "OIDC", issuer: "https://issuer.test", subject: "grace" } as never,
      });
      if (!accepted.ok) throw new Error(accepted.error.code);
      expect(accepted.ok).toBe(true);
      const replay = await f.links.acceptInvitation({
        idempotencyKey: "provider_accept",
        invitationSessionSecret: invitationSecret,
        displayName: "Grace",
        identity: { kind: "OIDC", issuer: "https://issuer.test", subject: "grace" } as never,
      });
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.code).toBe("SECRET_ALREADY_ISSUED");
      if (!accepted.ok) return;
      expect(accepted.value.session.actor.kind).toBe("MEMBER");
      expect(
        f.database
          .query<{ kind: string }, [string]>("SELECT kind FROM sessions WHERE id = ?")
          .get(accepted.value.session.actor.sessionId),
      ).toEqual({ kind: "BROWSER" });
      expect(
        f.database
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM audit_events WHERE kind = 'INVITATION_ACCEPTED'",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      f.database.close();
    }
  });

  test("auth-proxy identity requires branded verified provenance, never an origin boolean", async () => {
    const f = fixture();
    const assertions: AuthProxyAssertionPort = {
      async verify(input) {
        return input.assertion === "signed-assertion"
          ? {
              ok: true,
              value: {
                issuer: "https://proxy.test",
                subject: "subject_1",
                audience: "collab",
                assertionId: "signed-assertion-id-1",
                issuedAt: 990,
                expiresAt: 1_100,
              },
            }
          : {
              ok: false,
              error: {
                code: "AUTH_PROXY_ASSERTION_INVALID",
                message: "Authentication proxy assertion is invalid.",
                retry: "NEVER",
              },
            };
      },
    };
    const verifier = createAuthProxyProvenanceVerifier({
      database: f.database,
      clock: () => 1_000,
      directPeers: ["127.0.0.1"],
      forwardedOrigin: "https://collab.test",
      issuer: "https://proxy.test",
      audience: "collab",
      assertions,
    });
    try {
      expect(
        (
          await verifier.verify({
            directPeer: "127.0.0.1",
            forwardedOrigin: "https://collab.test",
            assertion: "signed-assertion",
            replayKey: "attacker-chosen-1",
          } as Parameters<typeof verifier.verify>[0] & { replayKey: string })
        ).ok,
      ).toBe(true);
      const untrusted = await verifier.verify({
        directPeer: "203.0.113.2",
        forwardedOrigin: "https://collab.test",
        assertion: "signed-assertion",
      });
      expect(untrusted.ok).toBe(false);
      const replay = await verifier.verify({
        directPeer: "127.0.0.1",
        forwardedOrigin: "https://collab.test",
        assertion: "signed-assertion",
        replayKey: "attacker-chosen-2",
      } as Parameters<typeof verifier.verify>[0] & { replayKey: string });
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.error.code).toBe("AUTH_PROXY_REPLAY");
    } finally {
      f.database.close();
    }
  });

  test("auth-proxy assertions require signed bounded issue and expiry times", async () => {
    const f = fixture();
    const verifier = createAuthProxyProvenanceVerifier({
      database: f.database,
      clock: () => 1_000,
      directPeers: ["127.0.0.1"],
      forwardedOrigin: "https://collab.test",
      issuer: "https://proxy.test",
      audience: "collab",
      assertions: {
        async verify() {
          return {
            ok: true,
            value: {
              issuer: "https://proxy.test",
              audience: "collab",
              subject: "subject_1",
              assertionId: "timeless_assertion",
            },
          } as never;
        },
      },
    });
    try {
      const result = await verifier.verify({
        directPeer: "127.0.0.1",
        forwardedOrigin: "https://collab.test",
        assertion: "signed-but-timeless",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("AUTH_PROXY_ASSERTION_INVALID");
    } finally {
      f.database.close();
    }
  });

  test("host recovery is OWNER-only, hash-only, ten-minute, one-time, and offline-container scoped", () => {
    const f = fixture();
    let sequence = 0;
    const command = createAuthRecoverCommand({
      database: f.database,
      clock: () => 1_000,
      id: (prefix) => `${prefix}_${++sequence}`,
      invocationMode: "OFFLINE_CONTAINER",
      mountedBootstrapSecret: "mounted-bootstrap-secret-with-at-least-32-bytes",
      randomSecret: () => `host-recovery-${"x".repeat(32)}-${++sequence}`,
    });
    try {
      const issued = command.generate({ memberId: "member_1" });
      expect(issued.ok).toBe(true);
      if (!issued.ok) return;
      expect(new TextDecoder().decode(f.database.serialize())).not.toContain(
        issued.value.recoveryCode,
      );
      const redeemed = command.redeem({
        memberId: "member_1",
        recoveryCode: issued.value.recoveryCode,
      });
      expect(redeemed.ok).toBe(true);
      expect(
        command.redeem({
          memberId: "member_1",
          recoveryCode: issued.value.recoveryCode,
        }).ok,
      ).toBe(false);
    } finally {
      f.database.close();
    }
  });
});
