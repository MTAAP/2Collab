import { describe, expect, test } from "bun:test";
import { createRunnerFixture } from "./runner-fixture.ts";

describe("runner pairing concurrency", () => {
  test("has exactly one consume winner", async () => {
    const fixture = createRunnerFixture();
    try {
      const begun = await fixture.registry.beginPairing({
        idempotencyKey: "concurrent_begin",
        principal: fixture.device("member_a"),
      });
      if (!begun.ok) throw new Error(begun.error.code);
      await fixture.registry.confirmPairing({
        idempotencyKey: "concurrent_confirm",
        actor: fixture.actor("member_a"),
        pairingId: begun.value.pairingId,
      });
      const results = await Promise.all([
        fixture.registry.consumePairing({
          idempotencyKey: "concurrent_consume_a",
          pairingSecret: begun.value.pairingSecret,
          keyId: "key_a",
          keyProof: "new:key_a",
        }),
        fixture.registry.consumePairing({
          idempotencyKey: "concurrent_consume_b",
          pairingSecret: begun.value.pairingSecret,
          keyId: "key_a",
          keyProof: "new:key_a",
        }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  for (const mutation of ["RUNNER_REVOKE", "MEMBER_OFFBOARD"] as const) {
    test(`does not authenticate stale authority when ${mutation.toLowerCase()} wins during proof finalization`, async () => {
      const fixture = createRunnerFixture();
      try {
        const paired = await fixture.pair("member_a");
        const access = await fixture.authentication.exchangeCredential({
          runnerCredential: paired.runnerCredential,
          keyProof: `possession:${paired.keyThumbprint}`,
        });
        if (!access.ok) throw new Error(access.error.code);
        let mutated = false;
        fixture.setBeforeDigest((value) => {
          if (mutated || !value.startsWith("RUNNER_DPOP:")) return;
          mutated = true;
          if (mutation === "RUNNER_REVOKE") {
            fixture.database
              .query(
                "UPDATE runners SET runner_epoch = runner_epoch + 1, revision = revision + 1, revoked_at = ? WHERE id = ?",
              )
              .run(fixture.now(), paired.runnerId);
          } else {
            fixture.database
              .query(
                "UPDATE members SET status = 'REVOKED', authority_epoch = authority_epoch + 1, revision = revision + 1 WHERE id = 'member_a'",
              )
              .run();
          }
        });
        const authenticated = await fixture.authentication.authenticateAccess({
          accessToken: access.value.accessToken,
          proof: `dpop:race_${mutation.toLowerCase()}`,
          nonce: access.value.nonce,
          method: "GET",
          uri: "https://collab.test/runner/v1",
        });
        expect(mutated).toBeTrue();
        expect(authenticated.ok).toBeFalse();
        if (!authenticated.ok) expect(authenticated.error.code).toBe("RUNNER_ACCESS_INVALID");
        expect(
          fixture.database
            .query<{ count: number }, []>("SELECT count(*) AS count FROM dpop_replays")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        fixture.close();
      }
    });
  }

  test("does not create an exposure when owner offboarding wins after authority inspection", async () => {
    const fixture = createRunnerFixture();
    try {
      const paired = await fixture.pair("member_a");
      const mapping = await fixture.registry.registerMapping({
        idempotencyKey: "race_mapping",
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        projectId: "project_1" as never,
        localMappingId: "local_race",
      });
      const profile = await fixture.registry.advertiseProfile({
        idempotencyKey: "race_profile",
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        displayName: "Race profile",
        adapter: "CODEX",
        hosts: ["NATIVE"],
        interactions: ["HEADLESS"],
        riskSummary: "Race test.",
        fingerprint: "d".repeat(64),
      });
      if (!mapping.ok || !profile.ok) throw new Error("setup failed");
      fixture.policyFactsStore.replaceForAuthority({
        runnerId: paired.runnerId,
        expectedPolicyRevision: 1,
        audience: "TEAM",
        maximumConcurrentAttempts: 1,
      });
      const preview = await fixture.registry.previewExposureAcknowledgement({
        actor: fixture.actor("member_a"),
        runnerId: paired.runnerId,
        projectId: "project_1" as never,
        mappingRevision: mapping.value.revision,
        profileId: profile.value.profileId,
        profileVersion: profile.value.version,
      });
      if (!preview.ok) throw new Error(preview.error.code);
      const acknowledgement = await fixture.registry.acknowledgeExposure({
        idempotencyKey: "race_ack",
        actor: fixture.actor("member_a"),
        ...preview.value.subject,
        expectedDigest: preview.value.digest,
      });
      if (!acknowledgement.ok) throw new Error(acknowledgement.error.code);

      let calls = 0;
      fixture.setBeforeClock(() => {
        calls += 1;
        if (calls !== 3) return;
        fixture.database.exec(
          "UPDATE members SET status = 'REVOKED', authority_epoch = authority_epoch + 1, revision = revision + 1 WHERE id = 'member_a'",
        );
      });
      const exposure = await fixture.registry.createExposure({
        idempotencyKey: "race_exposure",
        actor: fixture.actor("member_a"),
        acknowledgementId: acknowledgement.value.id,
      });
      fixture.setBeforeClock(undefined);
      expect(exposure.ok).toBeFalse();
      expect(
        fixture.database
          .query<{ count: number }, []>("SELECT count(*) AS count FROM runner_exposures")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      fixture.close();
    }
  });

  for (const operation of ["ACKNOWLEDGEMENT", "EXPOSURE", "RUNNER"] as const) {
    test(`does not commit ${operation.toLowerCase()} revocation after owner offboarding`, async () => {
      const fixture = createRunnerFixture();
      try {
        const paired = await fixture.pair("member_a");
        const exposed = await fixture.expose(paired.runnerId);
        const acknowledgement = fixture.database
          .query<{ id: string }, []>("SELECT id FROM runner_exposure_acknowledgements")
          .get();
        if (!acknowledgement) throw new Error("acknowledgement missing");
        let calls = 0;
        fixture.setBeforeClock(() => {
          calls += 1;
          if (calls !== 3) return;
          fixture.database.exec(
            "UPDATE members SET status = 'REVOKED', authority_epoch = authority_epoch + 1, revision = revision + 1 WHERE id = 'member_a'",
          );
        });
        const result =
          operation === "ACKNOWLEDGEMENT"
            ? await fixture.registry.revokeAcknowledgement({
                idempotencyKey: "race_revoke_ack",
                actor: fixture.actor("member_a"),
                acknowledgementId: acknowledgement.id as never,
                expectedVersion: 1,
              })
            : operation === "EXPOSURE"
              ? await fixture.registry.revokeExposure({
                  idempotencyKey: "race_revoke_exposure",
                  actor: fixture.actor("member_a"),
                  exposureId: exposed.exposureId,
                  expectedRevision: 1,
                })
              : await fixture.registry.revoke({
                  idempotencyKey: "race_revoke_runner",
                  actor: fixture.actor("member_a"),
                  runnerId: paired.runnerId,
                  expectedRunnerEpoch: 1,
                });
        fixture.setBeforeClock(undefined);
        expect(result.ok).toBeFalse();
        const state = fixture.database
          .query<
            {
              memberStatus: string;
              runnerRevoked: number | null;
              ackRevoked: number | null;
              exposureRevoked: number | null;
            },
            []
          >(
            `SELECT members.status AS memberStatus, runners.revoked_at AS runnerRevoked,
                    acknowledgements.revoked_at AS ackRevoked, exposures.revoked_at AS exposureRevoked
             FROM members, runners, runner_exposure_acknowledgements AS acknowledgements,
                  runner_exposures AS exposures
             WHERE members.id = 'member_a' AND runners.id = '${paired.runnerId}'`,
          )
          .get();
        expect(state).toEqual({
          memberStatus: "REVOKED",
          runnerRevoked: null,
          ackRevoked: null,
          exposureRevoked: null,
        });
      } finally {
        fixture.close();
      }
    });
  }
});
