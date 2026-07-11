import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../../../src/server/db/connection.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import { createRunnerServices } from "../../../src/server/modules/runners/runner-registry.ts";
import type { MemberActor, VerifiedDevicePrincipal } from "../../../src/shared/contracts/actors.ts";
import type { RegisteredRunnerId } from "../../../src/shared/contracts/ids.ts";

function hash(value: string): Uint8Array {
  return createHash("sha256").update(value).digest();
}

export function createRunnerFixture() {
  const database = openDatabase(":memory:");
  migrate(database);
  database.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at)
      VALUES ('deployment_1', 1, 'team_1', 1, 0);
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at) VALUES
      ('member_a', 'Ada', 'OWNER', 'ACTIVE', 1, 1, 0),
      ('member_b', 'Grace', 'MEMBER', 'ACTIVE', 1, 1, 0);
    INSERT INTO sessions(
      id, member_id, proof_hash, kind, expires_at, idle_expires_at, csrf_hash,
      absolute_expires_at, member_authority_epoch, revision, created_at
    ) VALUES
      ('session_a', 'member_a', X'${Buffer.from(hash("proof-member-a-with-at-least-32-bytes")).toString("hex")}', 'BROWSER', 10000, 10000, zeroblob(32), 10000, 1, 1, 0),
      ('session_b', 'member_b', X'${Buffer.from(hash("proof-member-b-with-at-least-32-bytes")).toString("hex")}', 'BROWSER', 10000, 10000, zeroblob(32), 10000, 1, 1, 0);
    INSERT INTO projects(id, team_id, name, base_branch, revision, created_at)
      VALUES ('project_1', 'team_1', 'Project', 'main', 1, 0);
    INSERT INTO device_credential_families(
      id, member_id, device_id, sender_key_thumbprint, current_refresh_hash,
      member_authority_epoch, revision, created_at, idle_expires_at, absolute_expires_at
    ) VALUES
      ('family_member_a', 'member_a', 'device_member_a', 'device_thumb_member_a', X'${"31".repeat(32)}', 1, 1, 0, 10000, 10000),
      ('family_member_b', 'member_b', 'device_member_b', 'device_thumb_member_b', X'${"32".repeat(32)}', 1, 1, 0, 10000, 10000);
  `);
  let now = 1_000;
  let sequence = 0;
  let beforeDigest: ((value: string) => void) | undefined;
  let beforeClock: (() => void) | undefined;
  let beforePossession: (() => void) | undefined;
  let afterQuery: ((sql: string) => void) | undefined;
  const serviceDatabase = new Proxy(database, {
    get(target, property) {
      if (property === "query") {
        return (sql: string) => {
          const statement = target.query(sql);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const value = Reflect.get(statementTarget, statementProperty);
              if (statementProperty === "get") {
                return (...parameters: unknown[]) => {
                  const result = (value as (...input: unknown[]) => unknown).apply(
                    statementTarget,
                    parameters,
                  );
                  afterQuery?.(sql);
                  return result;
                };
              }
              return typeof value === "function" ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;
  const services = createRunnerServices({
    database: serviceDatabase,
    clock: () => {
      beforeClock?.();
      return now;
    },
    id: (prefix) => `${prefix}_${++sequence}`,
    randomSecret: (prefix) => `${prefix}_${String(++sequence).padStart(40, "x")}`,
    digest: async (value) => {
      beforeDigest?.(value);
      return hash(value);
    },
    defaultSecurityDigest: "0".repeat(64),
    runnerKeyProof: {
      async verifyNewKey(input) {
        return input.proof === `new:${input.keyId}`
          ? { ok: true, value: { keyThumbprint: `thumb_${input.keyId}` } }
          : {
              ok: false,
              error: {
                code: "RUNNER_KEY_PROOF_INVALID",
                message: "Runner key proof is invalid.",
                retry: "NEVER",
              },
            };
      },
      async verifyPossession(input) {
        beforePossession?.();
        return input.proof === `possession:${input.keyThumbprint}`
          ? { ok: true, value: { verified: true as const } }
          : {
              ok: false,
              error: {
                code: "RUNNER_KEY_PROOF_INVALID",
                message: "Runner key proof is invalid.",
                retry: "NEVER",
              },
            };
      },
    },
    runnerRequestProof: {
      async verify(input) {
        const match = /^dpop:([A-Za-z0-9_-]{1,128})$/.exec(input.proof);
        return match && input.accessTokenHash.length === 64
          ? { ok: true, value: { jti: match[1] as string, issuedAt: now } }
          : {
              ok: false,
              error: {
                code: "RUNNER_DPOP_INVALID",
                message: "Runner request proof is invalid.",
                retry: "NEVER",
              },
            };
      },
    },
  });

  const actor = (memberId: "member_a" | "member_b"): MemberActor => ({
    kind: "MEMBER",
    memberId: memberId as never,
    sessionId: (memberId === "member_a" ? "session_a" : "session_b") as never,
    sessionProof:
      memberId === "member_a"
        ? "proof-member-a-with-at-least-32-bytes"
        : "proof-member-b-with-at-least-32-bytes",
  });
  const device = (memberId: "member_a" | "member_b"): VerifiedDevicePrincipal =>
    ({
      kind: "VERIFIED_DEVICE",
      memberId,
      memberAuthorityEpoch: 1,
      deviceFamilyId: `family_${memberId}`,
      deviceId: `device_${memberId}`,
      senderKeyThumbprint: `device_thumb_${memberId}`,
      expiresAt: 10_000,
    }) as never;

  async function pair(memberId: "member_a" | "member_b") {
    const begun = await services.registry.beginPairing({
      idempotencyKey: `pair_begin_${memberId}_${++sequence}`,
      principal: device(memberId),
    });
    if (!begun.ok) throw new Error(begun.error.code);
    const confirmed = await services.registry.confirmPairing({
      idempotencyKey: `pair_confirm_${memberId}_${++sequence}`,
      actor: actor(memberId),
      pairingId: begun.value.pairingId,
    });
    if (!confirmed.ok) throw new Error(confirmed.error.code);
    const keyId = `key_${memberId}`;
    const consumed = await services.registry.consumePairing({
      idempotencyKey: `pair_consume_${memberId}_${++sequence}`,
      pairingSecret: begun.value.pairingSecret,
      keyId,
      keyProof: `new:${keyId}`,
    });
    if (!consumed.ok) throw new Error(consumed.error.code);
    return consumed.value;
  }

  async function expose(runnerId: RegisteredRunnerId) {
    const mapping = await services.registry.registerMapping({
      idempotencyKey: `mapping_register_${++sequence}`,
      actor: actor("member_a"),
      runnerId,
      projectId: "project_1" as never,
      localMappingId: "local_mapping_1",
    });
    if (!mapping.ok) throw new Error(mapping.error.code);
    const profile = await services.registry.advertiseProfile({
      idempotencyKey: `profile_advertise_${++sequence}`,
      actor: actor("member_a"),
      runnerId,
      displayName: "Safe profile",
      adapter: "CODEX",
      hosts: ["NATIVE"],
      interactions: ["HEADLESS"],
      riskSummary: "Runs with the local operating-system user.",
      fingerprint: "a".repeat(64),
    });
    if (!profile.ok) throw new Error(profile.error.code);
    services.policyFactsStore.replaceForAuthority({
      runnerId,
      expectedPolicyRevision: 1,
      audience: "TEAM",
      maximumConcurrentAttempts: 1,
    });
    const preview = await services.registry.previewExposureAcknowledgement({
      actor: actor("member_a"),
      runnerId,
      projectId: "project_1" as never,
      mappingRevision: mapping.value.revision,
      profileId: profile.value.profileId,
      profileVersion: profile.value.version,
    });
    if (!preview.ok) throw new Error(preview.error.code);
    const acknowledgement = await services.registry.acknowledgeExposure({
      idempotencyKey: `exposure_ack_${++sequence}`,
      actor: actor("member_a"),
      ...preview.value.subject,
      expectedDigest: preview.value.digest,
    });
    if (!acknowledgement.ok) throw new Error(acknowledgement.error.code);
    const exposure = await services.registry.createExposure({
      idempotencyKey: `exposure_create_${++sequence}`,
      actor: actor("member_a"),
      acknowledgementId: acknowledgement.value.id,
    });
    if (!exposure.ok) throw new Error(exposure.error.code);
    return {
      runnerId,
      projectId: "project_1" as never,
      mappingRevision: mapping.value.revision,
      profileId: profile.value.profileId,
      profileVersion: profile.value.version,
      exposureId: exposure.value.id,
    };
  }

  async function authenticate(paired: Awaited<ReturnType<typeof pair>>, jti = "jti_1") {
    const access = await services.authentication.exchangeCredential({
      runnerCredential: paired.runnerCredential,
      keyProof: `possession:${paired.keyThumbprint}`,
    });
    if (!access.ok) throw new Error(access.error.code);
    const principal = await services.authentication.authenticateAccess({
      accessToken: access.value.accessToken,
      proof: `dpop:${jti}`,
      nonce: access.value.nonce,
      method: "GET",
      uri: "https://collab.test/runner/v1",
    });
    if (!principal.ok) throw new Error(principal.error.code);
    return { access: access.value, principal: principal.value };
  }

  return {
    ...services,
    database,
    actor,
    device,
    pair,
    authenticate,
    expose,
    now: () => now,
    setNow(value: number) {
      now = value;
    },
    setBeforeDigest(value: ((input: string) => void) | undefined) {
      beforeDigest = value;
    },
    setBeforeClock(value: (() => void) | undefined) {
      beforeClock = value;
    },
    setBeforePossession(value: (() => void) | undefined) {
      beforePossession = value;
    },
    setAfterQuery(value: ((sql: string) => void) | undefined) {
      afterQuery = value;
    },
    close() {
      database.close();
    },
  };
}
