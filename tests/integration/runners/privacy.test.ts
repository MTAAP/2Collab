import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner storage privacy", () => {
  test("makes private, missing, revoked, and non-team exposures indistinguishable to non-owners", async () => {
    const fixture = createRunnerFixture();
    try {
      const paired = await fixture.pair("member_a");
      const query = {
        actor: fixture.actor("member_b"),
        runnerId: paired.runnerId,
        projectId: "project_1" as never,
        mappingRevision: 1,
        profileId: "profile_private" as never,
        profileVersion: 1,
      };
      const privateResult = await fixture.registry.inspectEligibility(query);
      const exposed = await fixture.expose(paired.runnerId);
      const revoked = await fixture.registry.revokeExposure({
        idempotencyKey: "privacy_revoke",
        actor: fixture.actor("member_a"),
        exposureId: exposed.exposureId,
        expectedRevision: 1,
      });
      if (!revoked.ok) throw new Error(revoked.error.code);
      const revokedResult = await fixture.registry.inspectEligibility({
        actor: query.actor,
        ...exposed,
      });
      fixture.policyFactsStore.replaceForAuthority({
        runnerId: paired.runnerId,
        expectedPolicyRevision: 2,
        audience: "OWNER_ONLY",
        maximumConcurrentAttempts: 1,
      });
      const nonTeamResult = await fixture.registry.inspectEligibility({
        actor: query.actor,
        ...exposed,
      });
      expect(privateResult).toEqual({
        ok: false,
        error: {
          code: "RUNNER_NOT_OWNED_OR_EXPOSED",
          message: "Runner is not owned or exposed.",
          retry: "NEVER",
        },
      });
      expect(revokedResult).toEqual(privateResult);
      expect(nonTeamResult).toEqual(privateResult);
    } finally {
      fixture.close();
    }
  });

  test("has no columns for local paths, commands, environment, connector state, or clear secrets", () => {
    const fixture = createRunnerFixture();
    try {
      const columns = fixture.database
        .query<{ name: string }, []>(
          "SELECT name FROM pragma_table_info('runners') UNION ALL SELECT name FROM pragma_table_info('safe_profile_versions') UNION ALL SELECT name FROM pragma_table_info('runner_credentials')",
        )
        .all()
        .map((row) => row.name);
      for (const prohibited of [
        "local_path",
        "command",
        "arguments",
        "environment",
        "clear_secret",
        "connector_state",
        "clear_credential",
      ]) {
        expect(columns).not.toContain(prohibited);
      }
    } finally {
      fixture.close();
    }
  });
});
