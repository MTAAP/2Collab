import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../../src/server/db/connection.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import { createMemberRevocationAuthority } from "../../../src/server/modules/identity/revocation.ts";

function fixture(dispatchSucceeds = true, providerRevocations?: string[]) {
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
        return dispatchSucceeds
          ? { ok: true, value: { applied: true as const } }
          : {
              ok: false,
              error: {
                code: "EXECUTION_UNAVAILABLE",
                message: "Execution authority is unavailable.",
                retry: "REFRESH" as const,
              },
            };
      },
    },
    ...(providerRevocations
      ? {
          outlineProviderRevocation: {
            async revokeCredential(credentialId: string) {
              providerRevocations.push(credentialId);
              return { ok: true as const, value: { revoked: true as const } };
            },
          },
        }
      : {}),
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

  test("member removal rejects an owner session at the shared idle deadline", async () => {
    const f = fixture();
    try {
      f.database.exec("UPDATE sessions SET idle_expires_at = 1000 WHERE id = 'owner_session'");
      const result = await f.authority.remove({
        idempotencyKey: "remove_idle",
        actor: {
          kind: "MEMBER",
          memberId: "owner_1" as never,
          sessionId: "owner_session" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        memberId: "member_1" as never,
        expectedRevision: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("OWNER_REQUIRED");
    } finally {
      f.database.close();
    }
  });

  test("failed execution revocation stays durably pending and never reports dispatch", async () => {
    const f = fixture(false);
    try {
      const result = await f.authority.remove({
        idempotencyKey: "remove_pending",
        actor: {
          kind: "MEMBER",
          memberId: "owner_1" as never,
          sessionId: "owner_session" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        memberId: "member_1" as never,
        expectedRevision: 1,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.revocationDispatch).toBe("PENDING");
      expect(
        f.database
          .query<{ status: string }, []>(
            "SELECT status FROM authority_revocation_outbox WHERE id = 'remove_pending'",
          )
          .get(),
      ).toEqual({ status: "PENDING" });
    } finally {
      f.database.close();
    }
  });

  test("offboarding atomically invalidates delegated Outline identity and advances shared connector authority before provider revoke", async () => {
    const providerRevocations: string[] = [];
    const f = fixture(true, providerRevocations);
    try {
      f.database.exec(`
        INSERT INTO members(id,display_name,role,status,authority_epoch,revision,created_at)
          VALUES('member_2','Linus','MEMBER','ACTIVE',1,1,0);
        INSERT INTO connector_epochs(connector_id,epoch,review_state,revision) VALUES('outline_1',1,'READY',1);
        INSERT INTO connector_scopes(id,project_id,connector_id,connector_epoch,revision,created_at)
          VALUES('scope_outline','project_1','outline_1',1,1,0);
        INSERT INTO connector_scope_references(scope_id,reference) VALUES('scope_outline','OUTLINE_COLLECTION:c');
        INSERT INTO connector_scope_operations(scope_id,operation) VALUES('scope_outline','EDIT_CONTENT');
        INSERT INTO encrypted_credentials(id,credential_class,owner_kind,owner_id,connector_id,credential_owner_id,key_id,key_version,algorithm,nonce,ciphertext,auth_tag,revision,created_at,updated_at)
          VALUES('outline_bot','PROVIDER','CONNECTOR','outline_1','outline_1','bot','k',1,'AES_256_GCM',zeroblob(12),X'01',zeroblob(16),1,0,0),
                ('outline_member','MEMBER_OAUTH','MEMBER','member_1','outline_1','member_1','k',1,'AES_256_GCM',zeroblob(12),X'02',zeroblob(16),1,0,0),
                ('outline_member_2','MEMBER_OAUTH','MEMBER','member_2','outline_1','member_2','k',1,'AES_256_GCM',zeroblob(12),X'03',zeroblob(16),1,0,0);
        INSERT INTO outline_connections(connector_id,origin,workspace_id,bot_provider_user_id,bot_credential_id,oauth_client_id,oauth_metadata_digest,revision,created_at,updated_at)
          VALUES('outline_1','https://outline.test','workspace','bot-user','outline_bot','client','${"a".repeat(64)}',1,0,0);
        INSERT INTO outline_member_oauth_grants(id,connector_id,member_id,outline_user_id,credential_id,granted_scope_digest,access_expires_at,refresh_status,credential_revision,revision,created_at,updated_at)
          VALUES('outline_grant','outline_1','member_1','member-user','outline_member','${"b".repeat(64)}',10000,'READY',1,1,0,0),
                ('outline_grant_2','outline_1','member_2','member-user-2','outline_member_2','${"c".repeat(64)}',10000,'READY',1,1,0,0);
        INSERT INTO coordination_records(id,project_id,title,revision,created_at,updated_at)
          VALUES('record_1','project_1','Record',1,0,0);
        INSERT INTO agent_runs(id,coordination_record_id,project_id,state,goal,repository_id,repository_mode,
          repository_assurance,base_origin,base_commit,base_branch,intended_branch,worktree_identity,
          effective_configuration_id,effective_configuration_version,effective_configuration_digest,
          dispatcher_kind,dispatcher_id,revision,created_at)
          VALUES('run_1','record_1','project_1','QUEUED','Goal','repo_1','MUTATING','ENFORCED','EXACT','${"a".repeat(40)}','main','run-1','worktree_1','config_1',1,'${"d".repeat(64)}','MEMBER','member_1',1,0),
                ('run_2','record_1','project_1','QUEUED','Goal','repo_1','MUTATING','ENFORCED','EXACT','${"a".repeat(40)}','main','run-2','worktree_2','config_1',1,'${"d".repeat(64)}','MEMBER','member_2',1,0);
        INSERT INTO document_write_grants(grant_id,project_id,connector_id,run_id,grantor_member_id,
          connector_epoch,grant_revision,created_at,expires_at)
          VALUES('write_1','project_1','outline_1','run_1','member_1',1,1,0,10000),
                ('write_2','project_1','outline_1','run_2','member_2',1,1,0,10000);
        INSERT INTO additional_document_requests(request_id,grant_id,document_id,requested_by_run_id,status,request_revision,created_at)
          VALUES('request_1','write_1','doc_1','run_1','PENDING',1,0),
                ('request_2','write_2','doc_2','run_2','PENDING',1,0);
      `);
      const result = await f.authority.remove({
        idempotencyKey: "remove_outline",
        actor: {
          kind: "MEMBER",
          memberId: "owner_1" as never,
          sessionId: "owner_session" as never,
          sessionProof: "proof-with-at-least-thirty-two-bytes",
        },
        memberId: "member_1" as never,
        expectedRevision: 1,
      });
      expect(result.ok).toBe(true);
      expect(providerRevocations).toEqual(["outline_member"]);
      expect(
        f.database
          .query<{ refresh_status: string; revoked_at: number | null }, []>(
            "SELECT refresh_status,revoked_at FROM outline_member_oauth_grants WHERE id='outline_grant'",
          )
          .get(),
      ).toEqual({ refresh_status: "REVOKED", revoked_at: 1000 });
      expect(
        f.database
          .query<{ epoch: number }, []>(
            "SELECT epoch FROM connector_epochs WHERE connector_id='outline_1'",
          )
          .get()?.epoch,
      ).toBe(2);
      expect(
        f.database
          .query<{ grant_id: string; revoked_at: number | null }, []>(
            "SELECT grant_id,revoked_at FROM document_write_grants ORDER BY grant_id",
          )
          .all(),
      ).toEqual([
        { grant_id: "write_1", revoked_at: 1000 },
        { grant_id: "write_2", revoked_at: null },
      ]);
      expect(
        f.database
          .query<{ request_id: string; revoked_at: number | null }, []>(
            "SELECT request_id,revoked_at FROM additional_document_requests ORDER BY request_id",
          )
          .all(),
      ).toEqual([
        { request_id: "request_1", revoked_at: 1000 },
        { request_id: "request_2", revoked_at: null },
      ]);
      expect(
        f.database
          .query<{ connector_epoch: number }, []>(
            "SELECT connector_epoch FROM connector_scopes WHERE id='scope_outline'",
          )
          .get()?.connector_epoch,
      ).toBe(2);
    } finally {
      f.database.close();
    }
  });
});
