import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { MemberActor } from "../../../src/shared/contracts/actors.ts";
import { createRunnerFixture } from "./runner-fixture.ts";

const TOKEN = "better-auth-browser-token-with-at-least-thirty-two-characters";

function installBetterAuthBrowser(fixture: ReturnType<typeof createRunnerFixture>): MemberActor {
  fixture.database.exec(`
    INSERT INTO auth_users(id, name, email, emailVerified, createdAt, updatedAt)
    VALUES ('auth_member_a', 'Ada', 'auth_member_a@identity.invalid', 0, 1000000, 1000000);
    INSERT INTO auth_member_links(auth_user_id, member_id, authority_epoch_snapshot, created_at)
    VALUES ('auth_member_a', 'member_a', 1, 1000);
    INSERT INTO auth_sessions(
      id, expiresAt, token, createdAt, updatedAt, userId, purpose,
      memberAuthorityEpoch, absoluteExpiresAt
    ) VALUES (
      'auth_browser_a', 10000000, '${TOKEN}', 1000000, 1000000,
      'auth_member_a', 'BROWSER', 1, 10000000
    );
  `);
  return {
    kind: "MEMBER",
    memberId: "member_a" as never,
    sessionId: "auth_browser_a" as never,
    sessionProof: createHash("sha256").update(TOKEN).digest("base64url"),
  };
}

function installBetterAuthDevice(fixture: ReturnType<typeof createRunnerFixture>): MemberActor {
  const token = "better-auth-cli-token-with-at-least-thirty-two-characters";
  fixture.database
    .query(
      `INSERT INTO auth_sessions(
         id, expiresAt, token, createdAt, updatedAt, userId, purpose,
         memberAuthorityEpoch, absoluteExpiresAt
       ) VALUES (
         'auth_cli_a', 1600000, ?, 1000000, 1000000,
         'auth_member_a', 'CLI_DEVICE', 1, 1600000
       )`,
    )
    .run(token);
  return {
    kind: "MEMBER",
    memberId: "member_a" as never,
    sessionId: "auth_cli_a" as never,
    sessionProof: createHash("sha256").update(token).digest("base64url"),
  };
}

describe("runner Better Auth member authority", () => {
  test("confirms pairing and configures the owned runner without a legacy session", async () => {
    const fixture = createRunnerFixture();
    try {
      const actor = installBetterAuthBrowser(fixture);
      fixture.database.query("DELETE FROM sessions WHERE member_id = 'member_a'").run();

      const begun = await fixture.registry.beginPairing({
        idempotencyKey: "better_auth_pair_begin",
        principal: fixture.device("member_a"),
      });
      if (!begun.ok) throw new Error(begun.error.code);
      const confirmed = await fixture.registry.confirmPairing({
        idempotencyKey: "better_auth_pair_confirm",
        actor,
        pairingId: begun.value.pairingId,
      });
      expect(confirmed).toMatchObject({ ok: true });

      const consumed = await fixture.registry.consumePairing({
        idempotencyKey: "better_auth_pair_consume",
        pairingSecret: begun.value.pairingSecret,
        keyId: "better_auth_key",
        keyProof: "new:better_auth_key",
      });
      if (!consumed.ok) throw new Error(consumed.error.code);
      expect(
        await fixture.registry.registerMapping({
          idempotencyKey: "better_auth_mapping",
          actor,
          runnerId: consumed.value.runnerId,
          projectId: "project_1" as never,
          localMappingId: "better_auth_local_mapping",
        }),
      ).toMatchObject({ ok: true });
      expect(
        await fixture.registry.advertiseProfile({
          idempotencyKey: "better_auth_profile",
          actor,
          runnerId: consumed.value.runnerId,
          displayName: "Better Auth profile",
          adapter: "CODEX",
          hosts: ["NATIVE"],
          interactions: ["HEADLESS"],
          riskSummary: "Local execution under explicit runner ownership.",
          fingerprint: "a".repeat(64),
        }),
      ).toMatchObject({ ok: true });
      expect(
        fixture.database
          .query<{ kind: string; actor_kind: string; actor_id: string }, []>(
            `SELECT kind, actor_kind, actor_id FROM audit_events
             WHERE kind IN ('RUNNER_PAIRING_CONFIRMED', 'RUNNER_MAPPING_REGISTERED', 'RUNNER_PROFILE_ADVERTISED')
             ORDER BY kind`,
          )
          .all(),
      ).toEqual([
        {
          kind: "RUNNER_MAPPING_REGISTERED",
          actor_kind: "MEMBER",
          actor_id: "member_a",
        },
        {
          kind: "RUNNER_PAIRING_CONFIRMED",
          actor_kind: "MEMBER",
          actor_id: "member_a",
        },
        {
          kind: "RUNNER_PROFILE_ADVERTISED",
          actor_kind: "MEMBER",
          actor_id: "member_a",
        },
      ]);
    } finally {
      fixture.close();
    }
  });

  test("fails closed after member epoch changes between authentication and mutation", async () => {
    const fixture = createRunnerFixture();
    try {
      const actor = installBetterAuthBrowser(fixture);
      const runner = await fixture.pair("member_a");
      fixture.database.query("DELETE FROM sessions WHERE member_id = 'member_a'").run();
      fixture.database
        .query("UPDATE members SET authority_epoch = authority_epoch + 1 WHERE id = 'member_a'")
        .run();
      const mapping = await fixture.registry.registerMapping({
        idempotencyKey: "better_auth_stale_mapping",
        actor,
        runnerId: runner.runnerId,
        projectId: "project_1" as never,
        localMappingId: "stale_mapping",
      });
      expect(mapping.ok).toBeFalse();
      if (!mapping.ok) expect(mapping.error.code).toBe("RUNNER_OWNER_REQUIRED");
    } finally {
      fixture.close();
    }
  });

  test("authorizes runner configuration from an explicit Better Auth CLI-device session", async () => {
    const fixture = createRunnerFixture();
    try {
      installBetterAuthBrowser(fixture);
      const actor = installBetterAuthDevice(fixture);
      const runner = await fixture.pair("member_a");
      fixture.database.query("DELETE FROM sessions WHERE member_id = 'member_a'").run();
      const mapping = await fixture.registry.registerMapping({
        idempotencyKey: "better_auth_cli_mapping",
        actor,
        runnerId: runner.runnerId,
        projectId: "project_1" as never,
        localMappingId: "better_auth_cli_local_mapping",
      });
      expect(mapping).toMatchObject({ ok: true });
      expect(
        fixture.database
          .query<{ actor_kind: string; actor_id: string }, [string]>(
            `SELECT actor_kind, actor_id FROM audit_events
             WHERE kind = 'RUNNER_MAPPING_REGISTERED' AND subject_id = ?`,
          )
          .get(runner.runnerId),
      ).toEqual({ actor_kind: "MEMBER", actor_id: "member_a" });
    } finally {
      fixture.close();
    }
  });
});
