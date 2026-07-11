import { describe, expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import { openDatabase } from "../../../src/server/db/connection.ts";
import { createMemberRevocationAuthority } from "../../../src/server/modules/identity/revocation.ts";

function fixture() {
  const database = openDatabase(":memory:");
  migrate(database);
  database.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at)
      VALUES ('deployment_1', 1, 'team_1', 1, 0);
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at) VALUES
      ('owner_1', 'Ada', 'OWNER', 'ACTIVE', 1, 1, 0),
      ('member_1', 'Grace', 'MEMBER', 'ACTIVE', 1, 1, 0);
    INSERT INTO sessions(
      id, member_id, proof_hash, kind, expires_at, idle_expires_at, csrf_hash,
      absolute_expires_at, member_authority_epoch, revision, created_at
    ) VALUES
      ('owner_session', 'owner_1', X'${"11".repeat(32)}', 'BROWSER', 10000, 10000, X'${"12".repeat(32)}', 10000, 1, 1, 0),
      ('member_session', 'member_1', X'${"22".repeat(32)}', 'BROWSER', 10000, 10000, X'${"23".repeat(32)}', 10000, 1, 1, 0);
    INSERT INTO device_credential_families(
      id, member_id, device_id, sender_key_thumbprint, current_refresh_hash,
      revision, created_at, idle_expires_at, absolute_expires_at
    ) VALUES (
      'family_1', 'member_1', 'device_1', 'thumbprint_1', X'${"33".repeat(32)}',
      1, 0, 10000, 10000
    );
    INSERT INTO projects(id, team_id, name, base_branch, revision, created_at)
      VALUES ('project_1', 'team_1', 'Project', 'main', 1, 0);
    INSERT INTO runners(
      id, owner_member_id, runner_epoch, policy_revision, dispatch_audience,
      maximum_concurrent_attempts, security_policy_version, security_digest,
      revision, created_at
    ) VALUES ('runner_1', 'member_1', 1, 1, 'OWNER_ONLY', 1, 1, '${"0".repeat(64)}', 1, 0);
    INSERT INTO runner_credentials(
      id, runner_id, credential_hash, key_thumbprint, runner_epoch,
      member_authority_epoch, revision, created_at
    ) VALUES ('runner_credential_1', 'runner_1', X'${"44".repeat(32)}', 'runner_thumb_1', 1, 1, 1, 0);
    INSERT INTO runner_mapping_versions(
      runner_id, project_id, revision, local_mapping_id, created_at
    ) VALUES ('runner_1', 'project_1', 1, 'opaque_mapping_1', 0);
    INSERT INTO runner_pairings(
      id, pairing_secret_hash, device_member_id, device_member_authority_epoch,
      device_family_id, device_id, device_key_thumbprint, state, revision, created_at, expires_at
    ) VALUES (
      'runner_pairing_1', X'${"55".repeat(32)}', 'member_1', 1,
      'family_1', 'device_1', 'thumbprint_1', 'PENDING', 1, 500, 1100
    );
  `);
  const dispatched: string[] = [];
  const authority = createMemberRevocationAuthority({
    database,
    clock: () => 1_000,
    id: (prefix) => `${prefix}_${dispatched.length + 1}`,
    digest: async () => Uint8Array.from({ length: 32 }, () => 0x11),
    executionAuthority: {
      async execute(command) {
        const committed = database
          .query<{ status: string }, [string]>(
            "SELECT status FROM authority_revocation_outbox WHERE id = ?",
          )
          .get(command.idempotencyKey);
        expect(committed?.status).toBe("PENDING");
        dispatched.push(command.source.kind);
        return { ok: true, value: { applied: true } };
      },
    },
  });
  return { database, authority, dispatched };
}

describe("member offboarding", () => {
  test("atomically revokes membership, sessions, devices, credentials, epochs, and durable intent", async () => {
    const f = fixture();
    try {
      const removed = await f.authority.remove({
        idempotencyKey: "remove_1",
        actor: {
          kind: "MEMBER",
          memberId: "owner_1" as never,
          sessionId: "owner_session" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        memberId: "member_1" as never,
        expectedRevision: 1,
      });
      expect(removed.ok).toBe(true);
      if (!removed.ok) return;
      expect(removed.value.revokedEpochs).toEqual(["MEMBER", "RUNNER", "SESSION", "DEVICE"]);
      expect(f.dispatched).toEqual(["MEMBER"]);
      expect(
        f.database
          .query<{ status: string; authority_epoch: number }, []>(
            "SELECT status, authority_epoch FROM members WHERE id = 'member_1'",
          )
          .get(),
      ).toEqual({ status: "REVOKED", authority_epoch: 2 });
      expect(
        f.database
          .query<{ revoked_at: number | null }, []>(
            "SELECT revoked_at FROM sessions WHERE id = 'member_session'",
          )
          .get()?.revoked_at,
      ).toBe(1_000);
      expect(
        f.database
          .query<{ runner_epoch: number; revoked_at: number | null }, []>(
            "SELECT runner_epoch, revoked_at FROM runners WHERE id = 'runner_1'",
          )
          .get(),
      ).toEqual({ runner_epoch: 2, revoked_at: 1_000 });
      expect(
        f.database
          .query<{ revoked_at: number | null }, []>(
            "SELECT revoked_at FROM runner_credentials WHERE id = 'runner_credential_1'",
          )
          .get()?.revoked_at,
      ).toBe(1_000);
      expect(
        f.database
          .query<{ state: string }, []>(
            "SELECT state FROM runner_pairings WHERE id = 'runner_pairing_1'",
          )
          .get()?.state,
      ).toBe("REVOKED");
      expect(
        f.database
          .query<{ cause: string; runner_epoch: number; status: string }, []>(
            "SELECT cause, runner_epoch, status FROM runner_authority_change_outbox WHERE runner_id = 'runner_1'",
          )
          .get(),
      ).toEqual({ cause: "MEMBER_OFFBOARDING", runner_epoch: 2, status: "PENDING" });
    } finally {
      f.database.close();
    }
  });

  test("the last ACTIVE owner cannot be removed", async () => {
    const f = fixture();
    try {
      const result = await f.authority.remove({
        idempotencyKey: "remove_owner_1",
        actor: {
          kind: "MEMBER",
          memberId: "owner_1" as never,
          sessionId: "owner_session" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        memberId: "owner_1" as never,
        expectedRevision: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("LAST_OWNER_REQUIRED");
    } finally {
      f.database.close();
    }
  });
});
