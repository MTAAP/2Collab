import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner heartbeat", () => {
  test("derives never-connected, online, offline, and revoked state from server time", async () => {
    const fixture = createRunnerFixture();
    try {
      const paired = await fixture.pair("member_a");
      expect(fixture.registry.inspectLease(paired.runnerId)).toMatchObject({
        state: "NEVER_CONNECTED",
      });
      const authenticated = await fixture.authenticate(paired, "heartbeat_1");
      const callerStatus = await fixture.registry.heartbeat({
        idempotencyKey: "invalid_heartbeat",
        principal: authenticated.principal,
        status: "ONLINE",
        observedAt: 0,
      } as never);
      expect(callerStatus.ok).toBeFalse();
      await fixture.registry.heartbeat({
        idempotencyKey: "valid_heartbeat",
        principal: authenticated.principal,
      });
      fixture.setNow(fixture.now() + 29);
      expect(fixture.registry.inspectLease(paired.runnerId).state).toBe("ONLINE");
      fixture.setNow(fixture.now() + 1);
      expect(fixture.registry.inspectLease(paired.runnerId).state).toBe("OFFLINE");
    } finally {
      fixture.close();
    }
  });

  test("durably records only exact bases for the authenticated runner mapping", async () => {
    const fixture = createRunnerFixture();
    try {
      const paired = await fixture.pair("member_a");
      const mapping = await fixture.registry.registerMapping({
        idempotencyKey: "mapping_for_base_observation",
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        projectId: "project_1" as never,
        localMappingId: "local_repository_1",
      });
      if (!mapping.ok) throw new Error(mapping.error.code);
      const authenticated = await fixture.authenticate(paired, "repository_observation_1");
      const accepted = await fixture.registry.heartbeat({
        idempotencyKey: "heartbeat_with_base",
        principal: authenticated.principal,
        repositoryObservations: [
          {
            projectId: "project_1" as never,
            mappingRevision: mapping.value.revision,
            baseBranch: "main",
            baseCommit: "a".repeat(40) as never,
          },
        ],
      });
      expect(accepted.ok).toBeTrue();
      expect(
        fixture.database
          .query<{ base_commit: string; observed_at: number }, []>(
            "SELECT base_commit, observed_at FROM runner_repository_observations",
          )
          .get(),
      ).toEqual({ base_commit: "a".repeat(40), observed_at: fixture.now() });

      const rejected = await fixture.registry.heartbeat({
        idempotencyKey: "heartbeat_wrong_branch",
        principal: authenticated.principal,
        repositoryObservations: [
          {
            projectId: "project_1" as never,
            mappingRevision: mapping.value.revision,
            baseBranch: "other",
            baseCommit: "b".repeat(40) as never,
          },
        ],
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: "RUNNER_REPOSITORY_OBSERVATION_INVALID" },
      });
      expect(
        fixture.database
          .query<{ base_commit: string }, []>(
            "SELECT base_commit FROM runner_repository_observations",
          )
          .get()?.base_commit,
      ).toBe("a".repeat(40));
    } finally {
      fixture.close();
    }
  });
});
