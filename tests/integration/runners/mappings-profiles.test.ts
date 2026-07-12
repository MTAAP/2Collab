import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner mappings and profiles", () => {
  test("keeps one active version and rejects local execution details", async () => {
    const fixture = createRunnerFixture();
    try {
      const paired = await fixture.pair("member_a");
      const mapping = await fixture.registry.registerMapping({
        idempotencyKey: "mapping_create",
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        projectId: "project_1" as never,
        localMappingId: "opaque_1",
      });
      expect(mapping).toMatchObject({ ok: true, value: { revision: 1 } });
      const replaced = await fixture.registry.replaceMapping({
        idempotencyKey: "mapping_replace",
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        projectId: "project_1" as never,
        expectedRevision: 1,
        localMappingId: "opaque_2",
      });
      expect(replaced).toMatchObject({ ok: true, value: { revision: 2 } });
      const unsafe = await fixture.registry.advertiseProfile({
        idempotencyKey: "unsafe_profile",
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        displayName: "Unsafe",
        adapter: "CODEX",
        hosts: ["NATIVE"],
        interactions: ["HEADLESS"],
        riskSummary: "Risk",
        fingerprint: "a".repeat(64),
        command: "/usr/local/bin/codex",
      } as never);
      expect(unsafe.ok).toBeFalse();
      if (!unsafe.ok) expect(unsafe.error.code).toBe("RUNNER_PROFILE_INVALID");
    } finally {
      fixture.close();
    }
  });

  test("revoke mapping is idempotent, revisioned, audited, and rolls back with its audit", async () => {
    const fixture = createRunnerFixture();
    try {
      const paired = await fixture.pair("member_a");
      const created = await fixture.registry.registerMapping({
        idempotencyKey: "revoke_mapping_create",
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        projectId: "project_1" as never,
        localMappingId: "revoke_mapping_1",
      });
      if (!created.ok) throw new Error(created.error.code);
      const command = {
        idempotencyKey: "revoke_mapping_1",
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        projectId: "project_1" as never,
        expectedRevision: 1,
      };
      const first = await fixture.registry.revokeMapping(command);
      const replay = await fixture.registry.revokeMapping(command);
      const conflict = await fixture.registry.revokeMapping({
        ...command,
        expectedRevision: 2,
      });
      expect(first).toMatchObject({ ok: true, value: { revision: 1, revokedAt: fixture.now() } });
      expect(replay).toEqual(first);
      expect(conflict.ok).toBeFalse();
      if (!conflict.ok) expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(
        fixture.database
          .query<
            { actor_kind: string; actor_id: string; subject_id: string; safe_details: string },
            []
          >(
            "SELECT actor_kind, actor_id, subject_id, safe_details FROM audit_events WHERE kind = 'RUNNER_MAPPING_REVOKED'",
          )
          .get(),
      ).toEqual({
        actor_kind: "MEMBER",
        actor_id: "member_a",
        subject_id: paired.runnerId,
        safe_details: JSON.stringify({ ownerMemberId: "member_a", projectId: "project_1" }),
      });

      fixture.database.exec(`
        INSERT INTO projects(id, team_id, name, base_branch, revision, created_at)
          VALUES ('project_2', 'team_1', 'Project Two', 'main', 1, 0)
      `);
      const second = await fixture.registry.registerMapping({
        idempotencyKey: "revoke_mapping_create_2",
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        projectId: "project_2" as never,
        localMappingId: "revoke_mapping_2",
      });
      if (!second.ok) throw new Error(second.error.code);
      const stale = await fixture.registry.revokeMapping({
        idempotencyKey: "revoke_mapping_stale",
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        projectId: "project_2" as never,
        expectedRevision: 2,
      });
      expect(stale.ok).toBeFalse();
      if (!stale.ok) expect(stale.error.code).toBe("RUNNER_MAPPING_STALE");

      fixture.database.exec(`
        CREATE TRIGGER fail_runner_mapping_revoke_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.kind = 'RUNNER_MAPPING_REVOKED'
        BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END
      `);
      const rolledBack = await fixture.registry.revokeMapping({
        idempotencyKey: "revoke_mapping_rollback",
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        projectId: "project_2" as never,
        expectedRevision: 1,
      });
      expect(rolledBack).toMatchObject({
        ok: false,
        error: { code: "RUNNER_MAPPING_FAILED" },
      });
      expect(
        fixture.database
          .query<{ revoked_at: number | null }, [string]>(
            "SELECT revoked_at FROM runner_mapping_versions WHERE runner_id = ? AND project_id = 'project_2' AND revision = 1",
          )
          .get(paired.runnerId),
      ).toEqual({ revoked_at: null });
      expect(
        fixture.database
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM idempotency_results WHERE idempotency_key = 'revoke_mapping_rollback'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      fixture.close();
    }
  });
});
