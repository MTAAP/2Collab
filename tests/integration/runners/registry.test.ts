import { expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

test("runner registry preserves ownership and returns stale exposure facts", async () => {
  const fixture = createRunnerFixture();
  try {
    const runner = await fixture.pair("member_a");
    const denied = await fixture.registry.registerMapping({
      idempotencyKey: "denied_mapping",
      actor: fixture.actor("member_b"),
      runnerId: runner.runnerId,
      projectId: "project_1" as never,
      localMappingId: "mapping_private",
    });
    expect(denied.ok).toBeFalse();
    if (!denied.ok) expect(denied.error.code).toBe("RUNNER_OWNER_REQUIRED");

    const exposure = await fixture.expose(runner.runnerId);
    const current = await fixture.registry.inspectEligibility({
      actor: fixture.actor("member_b"),
      ...exposure,
    });
    expect(current.ok && current.value.disposition).toBe("CURRENT");

    fixture.policyFactsStore.replaceForAuthority({
      runnerId: runner.runnerId,
      expectedPolicyRevision: 2,
      audience: "TEAM",
      maximumConcurrentAttempts: 2,
    });
    const stale = await fixture.registry.inspectEligibility({
      actor: fixture.actor("member_b"),
      ...exposure,
    });
    expect(stale.ok).toBeFalse();
    if (!stale.ok) expect(stale.error.code).toBe("RUNNER_NOT_OWNED_OR_EXPOSED");
  } finally {
    fixture.close();
  }
});

test("runner writes replay safely, reject changed input, and audit the initiating actor", async () => {
  const fixture = createRunnerFixture();
  try {
    const runner = await fixture.pair("member_a");
    const command = {
      idempotencyKey: "mapping_idempotent_1",
      actor: fixture.actor("member_a"),
      runnerId: runner.runnerId,
      projectId: "project_1" as never,
      localMappingId: "mapping_idempotent",
    };
    const first = await fixture.registry.registerMapping(command as never);
    const replay = await fixture.registry.registerMapping(command as never);
    const conflict = await fixture.registry.registerMapping({
      ...command,
      localMappingId: "mapping_changed",
    } as never);
    expect(first).toMatchObject({ ok: true, value: { revision: 1 } });
    expect(replay).toEqual(first);
    expect(conflict.ok).toBeFalse();
    if (!conflict.ok) expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      fixture.database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM idempotency_results")
        .get(),
    ).toEqual({ count: 4 });
    expect(
      fixture.database
        .query<
          { actor_kind: string; actor_id: string; subject_id: string; safe_details: string },
          []
        >(
          `SELECT actor_kind, actor_id, subject_id, safe_details FROM audit_events
           WHERE kind = 'RUNNER_MAPPING_REGISTERED'`,
        )
        .get(),
    ).toEqual({
      actor_kind: "MEMBER",
      actor_id: "member_a",
      subject_id: runner.runnerId,
      safe_details: JSON.stringify({ ownerMemberId: "member_a", projectId: "project_1" }),
    });
    const persisted = JSON.stringify(
      fixture.database
        .query<Record<string, unknown>, []>("SELECT * FROM idempotency_results")
        .all(),
    );
    expect(persisted).not.toContain(runner.runnerCredential);
  } finally {
    fixture.close();
  }
});
