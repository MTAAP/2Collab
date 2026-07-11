import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("team runner exposures", () => {
  test("requires the exact server-authored acknowledgement and hides private facts", async () => {
    const fixture = createRunnerFixture();
    try {
      const paired = await fixture.pair("member_a");
      const privateLookup = await fixture.registry.inspectEligibility({
        actor: fixture.actor("member_b"),
        runnerId: paired.runnerId,
        projectId: "project_1" as never,
        mappingRevision: 1,
        profileId: "missing" as never,
        profileVersion: 1,
      });
      expect(privateLookup.ok).toBeFalse();
      if (!privateLookup.ok) expect(privateLookup.error.code).toBe("RUNNER_NOT_OWNED_OR_EXPOSED");
      const exposure = await fixture.expose(paired.runnerId);
      const current = await fixture.registry.inspectEligibility({
        actor: fixture.actor("member_b"),
        ...exposure,
      });
      expect(current.ok && current.value.authorizationSource).toBe("TEAM_EXPOSURE");
      const acknowledgement = fixture.database
        .query<{ acknowledgement_text: string }, []>(
          "SELECT acknowledgement_text FROM runner_exposure_acknowledgements",
        )
        .get();
      expect(acknowledgement?.acknowledgement_text).toContain("operating-system user");
      expect(acknowledgement?.acknowledgement_text).toContain("dedicated worktree");
      expect(acknowledgement?.acknowledgement_text).toContain("not a host sandbox");
      expect(() =>
        fixture.database.exec(
          "UPDATE runner_exposure_acknowledgements SET acknowledgement_text = 'changed'",
        ),
      ).toThrow("RUNNER_ACKNOWLEDGEMENT_IMMUTABLE");
      expect(() =>
        fixture.database.exec(`
          INSERT INTO runner_exposures(
            id, runner_id, owner_member_id, project_id, mapping_revision, profile_id,
            profile_version, profile_fingerprint, policy_revision, security_policy_version,
            security_digest, acknowledgement_id, revision, created_at
          ) SELECT
            'forged_exposure', runner_id, owner_member_id, project_id, mapping_revision + 1,
            profile_id, profile_version, profile_fingerprint, policy_revision,
            security_policy_version, security_digest, id, 1, accepted_at
          FROM runner_exposure_acknowledgements
        `),
      ).toThrow();

      const updatedProfile = await fixture.registry.advertiseProfile({
        idempotencyKey: "profile_update",
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        profileId: exposure.profileId,
        expectedVersion: 1,
        displayName: "Updated profile",
        adapter: "CODEX",
        hosts: ["NATIVE"],
        interactions: ["HEADLESS"],
        riskSummary: "Changed material risk.",
        fingerprint: "b".repeat(64),
      });
      expect(updatedProfile.ok).toBeTrue();
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
});
