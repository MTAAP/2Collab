import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type {
  ExposureAcknowledgementId,
  MemberId,
  ProjectId,
  RegisteredRunnerId,
  SafeProfileId,
} from "../../../shared/contracts/ids.ts";
import { CommitShaSchema, IdentifierSchema, Sha256Schema } from "../../../shared/contracts/ids.ts";
import { GitRefSchema } from "../../../shared/contracts/runners.ts";
import { MemberActorSchema } from "../../../shared/contracts/actors.ts";
import type { DomainError, Result } from "../../../shared/contracts/result.ts";
import type {
  ExposureAcknowledgement,
  ConfirmedRunnerPairing,
  ExposureSubject,
  RunnerCredentialEnvelope,
  RunnerEligibilityFacts,
  RunnerLeaseView,
  RunnerMapping,
  RunnerPolicyFacts,
  RunnerPairingChallenge,
  RunnerRevocation,
  SafeProfileVersion,
  TeamDispatchExposure,
} from "../../../shared/contracts/runners.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import { createRunnerAuthenticationAuthority } from "./authentication.ts";
import type {
  RunnerKeyProofPort,
  RunnerPolicyFactsStore,
  RunnerRegistry,
  RunnerRequestProofPort,
} from "./contract.ts";
import { exposureAcknowledgementDigest, exposureAcknowledgementText } from "./exposures.ts";
import { RUNNER_PAIRING_SECONDS, runnerDigest, runnerSecret, validRunnerId } from "./pairing.ts";

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  randomSecret?: (prefix: string) => string;
  digest?: (value: string) => Promise<Uint8Array>;
  defaultSecurityDigest: string;
  runnerKeyProof: RunnerKeyProofPort;
  runnerRequestProof: RunnerRequestProofPort;
}>;

type RunnerRow = Readonly<{
  id: string;
  owner_member_id: string;
  runner_epoch: number;
  policy_revision: number;
  dispatch_audience: "OWNER_ONLY" | "TEAM";
  maximum_concurrent_attempts: number;
  security_policy_version: number;
  security_digest: string;
  revision: number;
  created_at: number;
  last_heartbeat_at: number | null;
  revoked_at: number | null;
}>;

type MappingRow = Readonly<{
  runner_id: string;
  project_id: string;
  revision: number;
  local_mapping_id: string;
  created_at: number;
  revoked_at: number | null;
}>;

type ProfileRow = Readonly<{
  runner_id: string;
  profile_id: string;
  version: number;
  display_name: string;
  adapter: "CLAUDE" | "CODEX" | "PI" | "OPENCODE";
  supports_native: number;
  supports_orca: number;
  supports_headless: number;
  supports_interactive: number;
  risk_summary: string;
  fingerprint: string;
  created_at: number;
}>;

type AcknowledgementRow = Readonly<{
  id: string;
  version: number;
  runner_id: string;
  owner_member_id: string;
  project_id: string;
  mapping_revision: number;
  profile_id: string;
  profile_version: number;
  profile_fingerprint: string;
  policy_revision: number;
  security_policy_version: number;
  security_digest: string;
  acknowledgement_text: string;
  acknowledgement_digest: string;
  accepted_at: number;
  revoked_at: number | null;
}>;

type ExposureRow = Readonly<{
  id: string;
  runner_id: string;
  owner_member_id: string;
  project_id: string;
  mapping_revision: number;
  profile_id: string;
  profile_version: number;
  profile_fingerprint: string;
  policy_revision: number;
  security_policy_version: number;
  security_digest: string;
  acknowledgement_id: string;
  revision: number;
  created_at: number;
  revoked_at: number | null;
}>;

const PositiveRevisionSchema = z.number().int().positive();
const MappingBaseSchema = z
  .object({
    idempotencyKey: IdentifierSchema,
    actor: MemberActorSchema,
    runnerId: IdentifierSchema,
    projectId: IdentifierSchema,
    localMappingId: IdentifierSchema,
  })
  .strict();
const ProfileSchema = z
  .object({
    idempotencyKey: IdentifierSchema,
    actor: MemberActorSchema,
    runnerId: IdentifierSchema,
    profileId: IdentifierSchema.optional(),
    expectedVersion: PositiveRevisionSchema.optional(),
    displayName: z.string().trim().min(1).max(120),
    adapter: z.enum(["CLAUDE", "CODEX", "PI", "OPENCODE"]),
    hosts: z
      .array(z.enum(["NATIVE", "ORCA"]))
      .min(1)
      .max(2),
    interactions: z
      .array(z.enum(["HEADLESS", "INTERACTIVE"]))
      .min(1)
      .max(2),
    riskSummary: z.string().trim().min(1).max(240),
    fingerprint: Sha256Schema,
  })
  .strict()
  .refine((value) => new Set(value.hosts).size === value.hosts.length)
  .refine((value) => new Set(value.interactions).size === value.interactions.length)
  .refine((value) => (value.profileId === undefined) === (value.expectedVersion === undefined));
const PreviewSchema = z
  .object({
    actor: MemberActorSchema,
    runnerId: IdentifierSchema,
    projectId: IdentifierSchema,
    mappingRevision: PositiveRevisionSchema,
    profileId: IdentifierSchema,
    profileVersion: PositiveRevisionSchema,
  })
  .strict();
const SubjectSchema = z
  .object({
    runnerId: IdentifierSchema,
    ownerMemberId: IdentifierSchema,
    projectId: IdentifierSchema,
    mappingRevision: PositiveRevisionSchema,
    profileId: IdentifierSchema,
    profileVersion: PositiveRevisionSchema,
    profileFingerprint: Sha256Schema,
    policyRevision: PositiveRevisionSchema,
    securityPolicyVersion: PositiveRevisionSchema,
    securityDigest: Sha256Schema,
  })
  .strict();

function failure<T>(
  code: string,
  message: string,
  retry: DomainError["retry"] = "NEVER",
): Result<T> {
  return { ok: false, error: { code, message, retry } };
}

function mappingView(row: MappingRow): RunnerMapping {
  return {
    runnerId: row.runner_id as RegisteredRunnerId,
    projectId: row.project_id as ProjectId,
    revision: row.revision,
    localMappingId: row.local_mapping_id,
    createdAt: row.created_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

function profileView(row: ProfileRow): SafeProfileVersion {
  const hosts = [
    ...(row.supports_native ? (["NATIVE"] as const) : []),
    ...(row.supports_orca ? (["ORCA"] as const) : []),
  ];
  const interactions = [
    ...(row.supports_headless ? (["HEADLESS"] as const) : []),
    ...(row.supports_interactive ? (["INTERACTIVE"] as const) : []),
  ];
  return {
    runnerId: row.runner_id as RegisteredRunnerId,
    profileId: row.profile_id as SafeProfileId,
    displayName: row.display_name,
    adapter: row.adapter,
    hosts,
    interactions,
    riskSummary: row.risk_summary,
    version: row.version,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
  };
}

function acknowledgementView(row: AcknowledgementRow): ExposureAcknowledgement {
  return {
    id: row.id as ExposureAcknowledgementId,
    version: row.version,
    runnerId: row.runner_id as RegisteredRunnerId,
    ownerMemberId: row.owner_member_id as MemberId,
    projectId: row.project_id as ProjectId,
    mappingRevision: row.mapping_revision,
    profileId: row.profile_id as SafeProfileId,
    profileVersion: row.profile_version,
    profileFingerprint: row.profile_fingerprint,
    policyRevision: row.policy_revision,
    securityPolicyVersion: row.security_policy_version,
    securityDigest: row.security_digest,
    text: row.acknowledgement_text,
    digest: row.acknowledgement_digest,
    acceptedAt: row.accepted_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

function exposureView(row: ExposureRow): TeamDispatchExposure {
  return {
    id: row.id,
    runnerId: row.runner_id as RegisteredRunnerId,
    ownerMemberId: row.owner_member_id as MemberId,
    projectId: row.project_id as ProjectId,
    mappingRevision: row.mapping_revision,
    profileId: row.profile_id as SafeProfileId,
    profileVersion: row.profile_version,
    profileFingerprint: row.profile_fingerprint,
    policyRevision: row.policy_revision,
    securityPolicyVersion: row.security_policy_version,
    securityDigest: row.security_digest,
    acknowledgementId: row.acknowledgement_id as ExposureAcknowledgementId,
    revision: row.revision,
    createdAt: row.created_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

export function createRunnerServices(dependencies: Dependencies) {
  if (!Sha256Schema.safeParse(dependencies.defaultSecurityDigest).success) {
    throw new Error("RUNNER_CONFIGURATION_INVALID");
  }
  const digest = dependencies.digest ?? runnerDigest;
  const randomSecret = dependencies.randomSecret ?? runnerSecret;

  type WriteTicket = Readonly<{ actorId: string; key: string; inputHash: string }>;
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  };
  const writeTicket = async (
    operation: string,
    actorId: string,
    key: string,
    safeInput: unknown,
  ): Promise<WriteTicket> => ({
    actorId: `RUNNER_${operation}:${actorId}`,
    key,
    inputHash: Buffer.from(
      await digest(`RUNNER_WRITE:${operation}:${canonical(safeInput)}`),
    ).toString("hex"),
  });
  const replayWrite = <T>(ticket: WriteTicket): Result<T> | null => {
    const row = dependencies.database
      .query<{ input_hash: string; result_json: string }, [string, string]>(
        "SELECT input_hash, result_json FROM idempotency_results WHERE actor_id = ? AND idempotency_key = ?",
      )
      .get(ticket.actorId, ticket.key);
    if (!row) return null;
    if (row.input_hash !== ticket.inputHash) {
      return failure("IDEMPOTENCY_CONFLICT", "Idempotency key was used with different input.");
    }
    try {
      const stored = JSON.parse(row.result_json) as
        | Readonly<{ kind: "SECRET_ISSUED" }>
        | Readonly<{ kind: "RESULT"; result: Result<T> }>;
      return stored.kind === "RESULT"
        ? stored.result
        : failure("SECRET_ALREADY_ISSUED", "Runner secret was already issued.");
    } catch {
      return failure("RUNNER_IDEMPOTENCY_FAILED", "Runner idempotency state is invalid.");
    }
  };
  const storeWrite = <T>(
    ticket: WriteTicket,
    result: Result<T>,
    input: Readonly<{
      secret?: boolean;
      auditKind: string;
      actorKind: "DEVICE" | "MEMBER" | "RUNNER";
      actorId: string;
      subjectId?: string;
      safeDetails: Readonly<Record<string, unknown>>;
    }>,
  ): Result<T> => {
    dependencies.database
      .query(
        `INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        ticket.actorId,
        ticket.key,
        ticket.inputHash,
        JSON.stringify(input.secret ? { kind: "SECRET_ISSUED" } : { kind: "RESULT", result }),
        dependencies.clock(),
      );
    dependencies.database
      .query(
        `INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dependencies.id("audit"),
        input.auditKind,
        input.actorKind,
        input.actorId,
        input.subjectId ?? null,
        canonical(input.safeDetails),
        dependencies.clock(),
      );
    return result;
  };

  const memberAuthority = async (actor: MemberActor) => {
    if (actor.sessionProof.length < 32 || actor.sessionProof.length > 512) return null;
    const proofHash = await digest(actor.sessionProof);
    const member = dependencies.database
      .query<{ member_id: string }, [string, string, Uint8Array, number, number]>(
        `SELECT members.id AS member_id FROM members
         JOIN sessions ON sessions.member_id = members.id
         WHERE members.id = ? AND sessions.id = ? AND sessions.proof_hash = ?
           AND members.status = 'ACTIVE' AND sessions.kind = 'BROWSER'
           AND sessions.revoked_at IS NULL
           AND sessions.idle_expires_at > ? AND sessions.absolute_expires_at > ?
           AND sessions.member_authority_epoch = members.authority_epoch`,
      )
      .get(actor.memberId, actor.sessionId, proofHash, dependencies.clock(), dependencies.clock());
    return member ? { memberId: member.member_id, proofHash } : null;
  };

  const revalidateMemberAuthority = (actor: MemberActor, proofHash: Uint8Array): boolean =>
    dependencies.database
      .query<{ member_id: string }, [string, string, Uint8Array, number, number]>(
        `SELECT members.id AS member_id FROM members
         JOIN sessions ON sessions.member_id = members.id
         WHERE members.id = ? AND sessions.id = ? AND sessions.proof_hash = ?
           AND members.status = 'ACTIVE' AND sessions.kind = 'BROWSER'
           AND sessions.revoked_at IS NULL
           AND sessions.idle_expires_at > ? AND sessions.absolute_expires_at > ?
           AND sessions.member_authority_epoch = members.authority_epoch`,
      )
      .get(
        actor.memberId,
        actor.sessionId,
        proofHash,
        dependencies.clock(),
        dependencies.clock(),
      ) !== null;

  const revalidateOwner = (
    actor: MemberActor,
    proofHash: Uint8Array,
    runnerId: string,
  ): RunnerRow | null => {
    if (!revalidateMemberAuthority(actor, proofHash)) return null;
    return (
      dependencies.database
        .query<RunnerRow, [string, string]>(
          "SELECT * FROM runners WHERE id = ? AND owner_member_id = ? AND revoked_at IS NULL",
        )
        .get(runnerId, actor.memberId) ?? null
    );
  };

  const activeOwner = async (actor: MemberActor, runnerId: string) => {
    const member = await memberAuthority(actor);
    if (!member) return null;
    const runner = dependencies.database
      .query<RunnerRow, [string, string]>(
        "SELECT * FROM runners WHERE id = ? AND owner_member_id = ? AND revoked_at IS NULL",
      )
      .get(runnerId, member.memberId);
    return runner ? { member, runner } : null;
  };

  const runnerById = (runnerId: string) =>
    dependencies.database
      .query<RunnerRow, [string]>("SELECT * FROM runners WHERE id = ?")
      .get(runnerId);

  const currentSubject = (
    runnerId: string,
    projectId: string,
    mappingRevision: number,
    profileId: string,
    profileVersion: number,
  ): ExposureSubject | null => {
    const row = dependencies.database
      .query<
        {
          owner_member_id: string;
          policy_revision: number;
          security_policy_version: number;
          security_digest: string;
          fingerprint: string;
        },
        [string, number, string, number, string]
      >(
        `SELECT runners.owner_member_id, runners.policy_revision,
                runners.security_policy_version, runners.security_digest, profiles.fingerprint
         FROM runners
         JOIN runner_mapping_versions AS mappings
           ON mappings.runner_id = runners.id AND mappings.project_id = ? AND mappings.revision = ?
         JOIN safe_profile_versions AS profiles
           ON profiles.runner_id = runners.id AND profiles.profile_id = ? AND profiles.version = ?
         WHERE runners.id = ? AND runners.revoked_at IS NULL AND mappings.revoked_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM safe_profile_versions AS newer
             WHERE newer.runner_id = profiles.runner_id AND newer.profile_id = profiles.profile_id
               AND newer.version > profiles.version
           )`,
      )
      .get(projectId, mappingRevision, profileId, profileVersion, runnerId);
    return row
      ? {
          runnerId: runnerId as RegisteredRunnerId,
          ownerMemberId: row.owner_member_id as MemberId,
          projectId: projectId as ProjectId,
          mappingRevision,
          profileId: profileId as SafeProfileId,
          profileVersion,
          profileFingerprint: row.fingerprint,
          policyRevision: row.policy_revision,
          securityPolicyVersion: row.security_policy_version,
          securityDigest: row.security_digest,
        }
      : null;
  };

  const inspectLease = (runnerId: string): RunnerLeaseView => {
    const runner = runnerById(runnerId);
    if (!runner) throw new Error("RUNNER_NOT_FOUND");
    const observedAt = dependencies.clock();
    const state =
      runner.revoked_at !== null
        ? "REVOKED"
        : runner.last_heartbeat_at === null
          ? "NEVER_CONNECTED"
          : observedAt - runner.last_heartbeat_at < 30
            ? "ONLINE"
            : "OFFLINE";
    return {
      runnerId: runner.id as RegisteredRunnerId,
      runnerEpoch: runner.runner_epoch,
      state,
      ...(runner.last_heartbeat_at === null ? {} : { lastHeartbeatAt: runner.last_heartbeat_at }),
      observedAt,
    };
  };

  const registry: RunnerRegistry = {
    async beginPairing(command) {
      const input = z
        .object({
          idempotencyKey: IdentifierSchema,
          principal: z
            .object({
              kind: z.literal("VERIFIED_DEVICE"),
              memberId: IdentifierSchema,
              memberAuthorityEpoch: PositiveRevisionSchema,
              deviceFamilyId: IdentifierSchema,
              deviceId: IdentifierSchema,
              senderKeyThumbprint: IdentifierSchema,
              expiresAt: z.number().int().positive(),
            })
            .strict(),
        })
        .strict()
        .safeParse(command);
      if (!input.success) return failure("RUNNER_PAIRING_INVALID", "Runner pairing is invalid.");
      if (dependencies.clock() >= input.data.principal.expiresAt) {
        return failure("RUNNER_PAIRING_INVALID", "Runner pairing is invalid.");
      }
      const currentDevice = dependencies.database
        .query<{ id: string }, [string, number, string, string, string]>(
          `SELECT families.id FROM device_credential_families AS families
           JOIN members ON members.id = families.member_id
           WHERE families.member_id = ? AND families.member_authority_epoch = ?
             AND families.id = ? AND families.device_id = ? AND families.sender_key_thumbprint = ?
             AND families.revoked_at IS NULL AND members.status = 'ACTIVE'
             AND members.authority_epoch = families.member_authority_epoch`,
        )
        .get(
          input.data.principal.memberId,
          input.data.principal.memberAuthorityEpoch,
          input.data.principal.deviceFamilyId,
          input.data.principal.deviceId,
          input.data.principal.senderKeyThumbprint,
        );
      if (!currentDevice)
        return failure("RUNNER_PAIRING_DEVICE_INVALID", "Runner pairing device is invalid.");
      const ticket = await writeTicket(
        "PAIRING_BEGIN",
        input.data.principal.deviceFamilyId,
        input.data.idempotencyKey,
        {
          memberId: input.data.principal.memberId,
          memberAuthorityEpoch: input.data.principal.memberAuthorityEpoch,
          deviceFamilyId: input.data.principal.deviceFamilyId,
          deviceId: input.data.principal.deviceId,
          senderKeyThumbprint: input.data.principal.senderKeyThumbprint,
          expiresAt: input.data.principal.expiresAt,
        },
      );
      const prior = replayWrite<RunnerPairingChallenge>(ticket);
      if (prior) return prior;
      const pairingSecret = randomSecret("runner_pairing");
      const pairingHash = await digest(pairingSecret);
      const pairingId = dependencies.id("runner_pairing");
      const now = dependencies.clock();
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const raced = replayWrite<RunnerPairingChallenge>(ticket);
          if (raced) return raced;
          dependencies.database
            .query(
              `INSERT INTO runner_pairings(
                 id, pairing_secret_hash, device_member_id, device_member_authority_epoch,
                 device_family_id, device_id, device_key_thumbprint, state, revision, created_at, expires_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?, ?)`,
            )
            .run(
              pairingId,
              pairingHash,
              input.data.principal.memberId,
              input.data.principal.memberAuthorityEpoch,
              input.data.principal.deviceFamilyId,
              input.data.principal.deviceId,
              input.data.principal.senderKeyThumbprint,
              now,
              now + RUNNER_PAIRING_SECONDS,
            );
          const result = {
            ok: true as const,
            value: { pairingId, pairingSecret, expiresAt: now + RUNNER_PAIRING_SECONDS },
          };
          return storeWrite(ticket, result, {
            secret: true,
            auditKind: "RUNNER_PAIRING_BEGUN",
            actorKind: "DEVICE",
            actorId: input.data.principal.deviceFamilyId,
            subjectId: pairingId,
            safeDetails: { ownerMemberId: input.data.principal.memberId },
          });
        });
      } catch {
        return failure("RUNNER_PAIRING_FAILED", "Runner pairing failed.");
      }
    },

    async confirmPairing(command) {
      const input = z
        .object({
          idempotencyKey: IdentifierSchema,
          actor: MemberActorSchema,
          pairingId: IdentifierSchema,
        })
        .strict()
        .safeParse(command);
      if (!input.success) return failure("RUNNER_PAIRING_INVALID", "Runner pairing is invalid.");
      const authority = await memberAuthority(input.data.actor as MemberActor);
      if (!authority) return failure("SESSION_INVALID", "Member session is invalid.");
      const pairing = dependencies.database
        .query<
          { device_member_id: string; revision: number; expires_at: number; state: string },
          [string]
        >("SELECT device_member_id, revision, expires_at, state FROM runner_pairings WHERE id = ?")
        .get(input.data.pairingId);
      if (pairing?.device_member_id !== authority.memberId) {
        return failure("RUNNER_PAIRING_MEMBER_MISMATCH", "Runner pairing member does not match.");
      }
      const ticket = await writeTicket(
        "PAIRING_CONFIRM",
        authority.memberId,
        input.data.idempotencyKey,
        { pairingId: input.data.pairingId },
      );
      const prior = replayWrite<ConfirmedRunnerPairing>(ticket);
      if (prior) return prior;
      const now = dependencies.clock();
      return inImmediateTransaction(dependencies.database, () => {
        const raced = replayWrite<ConfirmedRunnerPairing>(ticket);
        if (raced) return raced;
        if (!revalidateMemberAuthority(input.data.actor as MemberActor, authority.proofHash)) {
          return failure("AUTHORITY_STALE", "Identity authority changed.", "REFRESH");
        }
        const changed = dependencies.database
          .query(
            `UPDATE runner_pairings SET state = 'CONFIRMED', confirmed_at = ?, revision = revision + 1
             WHERE id = ? AND revision = ? AND state = 'PENDING' AND expires_at > ?`,
          )
          .run(now, input.data.pairingId, pairing.revision, now);
        if (changed.changes !== 1) {
          return failure("RUNNER_PAIRING_INVALID", "Runner pairing is invalid.");
        }
        const result = {
          ok: true as const,
          value: { pairingId: input.data.pairingId, confirmedAt: now },
        };
        return storeWrite(ticket, result, {
          auditKind: "RUNNER_PAIRING_CONFIRMED",
          actorKind: "MEMBER",
          actorId: authority.memberId,
          subjectId: input.data.pairingId,
          safeDetails: { ownerMemberId: authority.memberId },
        });
      });
    },

    async consumePairing(command) {
      const input = z
        .object({
          idempotencyKey: IdentifierSchema,
          pairingSecret: z.string().min(32).max(512),
          keyId: IdentifierSchema,
          keyProof: z.string().min(1).max(2048),
        })
        .strict()
        .safeParse(command);
      if (!input.success) return failure("RUNNER_PAIRING_INVALID", "Runner pairing is invalid.");
      const pairingHash = await digest(input.data.pairingSecret);
      const pairing = dependencies.database
        .query<
          {
            id: string;
            device_member_id: string;
            device_member_authority_epoch: number;
            device_family_id: string;
            state: string;
            revision: number;
            expires_at: number;
          },
          [Uint8Array]
        >("SELECT * FROM runner_pairings WHERE pairing_secret_hash = ?")
        .get(pairingHash);
      if (!pairing) return failure("RUNNER_PAIRING_INVALID", "Runner pairing is invalid.");
      const ticket = await writeTicket(
        "PAIRING_CONSUME",
        pairing.device_family_id,
        input.data.idempotencyKey,
        {
          pairingId: pairing.id,
          keyId: input.data.keyId,
        },
      );
      const prior = replayWrite<RunnerCredentialEnvelope>(ticket);
      if (prior) return prior;
      if (pairing.state === "CONSUMED") {
        return failure("RUNNER_PAIRING_CONSUMED", "Runner pairing was already consumed.");
      }
      if (pairing.state !== "CONFIRMED" || dependencies.clock() >= pairing.expires_at) {
        return failure("RUNNER_PAIRING_INVALID", "Runner pairing is invalid.");
      }
      const key = await dependencies.runnerKeyProof.verifyNewKey({
        keyId: input.data.keyId,
        proof: input.data.keyProof,
      });
      if (!key.ok) return key;
      if (!validRunnerId(key.value.keyThumbprint)) {
        return failure("RUNNER_KEY_PROOF_INVALID", "Runner key proof is invalid.");
      }
      const credential = randomSecret("runner_credential");
      const credentialHash = await digest(credential);
      const runnerId = dependencies.id("runner");
      const credentialId = dependencies.id("runner_credential");
      const now = dependencies.clock();
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const member = dependencies.database
            .query<{ id: string }, [string, number]>(
              "SELECT id FROM members WHERE id = ? AND authority_epoch = ? AND status = 'ACTIVE'",
            )
            .get(pairing.device_member_id, pairing.device_member_authority_epoch);
          if (!member) return failure("RUNNER_PAIRING_INVALID", "Runner pairing is invalid.");
          const changed = dependencies.database
            .query(
              `UPDATE runner_pairings SET state = 'CONSUMED', consumed_at = ?, revision = revision + 1
               WHERE id = ? AND revision = ? AND state = 'CONFIRMED' AND expires_at > ?`,
            )
            .run(now, pairing.id, pairing.revision, now);
          if (changed.changes !== 1) {
            const consumed = dependencies.database
              .query<{ state: string }, [string]>("SELECT state FROM runner_pairings WHERE id = ?")
              .get(pairing.id);
            return consumed?.state === "CONSUMED"
              ? failure("RUNNER_PAIRING_CONSUMED", "Runner pairing was already consumed.")
              : failure("RUNNER_PAIRING_INVALID", "Runner pairing is invalid.");
          }
          dependencies.database
            .query(
              `INSERT INTO runners(
                 id, owner_member_id, runner_epoch, policy_revision, dispatch_audience,
                 maximum_concurrent_attempts, security_policy_version, security_digest,
                 revision, created_at
               ) VALUES (?, ?, 1, 1, 'OWNER_ONLY', 1, 1, ?, 1, ?)`,
            )
            .run(runnerId, pairing.device_member_id, dependencies.defaultSecurityDigest, now);
          dependencies.database
            .query(
              `INSERT INTO runner_credentials(
                 id, runner_id, credential_hash, key_thumbprint, runner_epoch,
                 member_authority_epoch, revision, created_at
               ) VALUES (?, ?, ?, ?, 1, ?, 1, ?)`,
            )
            .run(
              credentialId,
              runnerId,
              credentialHash,
              key.value.keyThumbprint,
              pairing.device_member_authority_epoch,
              now,
            );
          const result = {
            ok: true,
            value: {
              runnerId: runnerId as RegisteredRunnerId,
              runnerEpoch: 1,
              ownerMemberId: pairing.device_member_id as MemberId,
              runnerCredential: credential,
              keyThumbprint: key.value.keyThumbprint,
            },
          } as const;
          return storeWrite(ticket, result, {
            secret: true,
            auditKind: "RUNNER_CREDENTIAL_ISSUED",
            actorKind: "DEVICE",
            actorId: pairing.device_family_id,
            subjectId: runnerId,
            safeDetails: { ownerMemberId: pairing.device_member_id },
          });
        });
      } catch {
        return failure("RUNNER_PAIRING_FAILED", "Runner pairing failed.");
      }
    },

    async registerMapping(command) {
      const input = MappingBaseSchema.safeParse(command);
      if (!input.success) return failure("RUNNER_MAPPING_INVALID", "Runner mapping is invalid.");
      const owner = await activeOwner(input.data.actor as MemberActor, input.data.runnerId);
      if (!owner)
        return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
      const ticket = await writeTicket(
        "MAPPING_REGISTER",
        owner.member.memberId,
        input.data.idempotencyKey,
        {
          runnerId: input.data.runnerId,
          projectId: input.data.projectId,
          localMappingId: input.data.localMappingId,
        },
      );
      const prior = replayWrite<RunnerMapping>(ticket);
      if (prior) return prior;
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const raced = replayWrite<RunnerMapping>(ticket);
          if (raced) return raced;
          if (
            !revalidateOwner(
              input.data.actor as MemberActor,
              owner.member.proofHash,
              input.data.runnerId,
            )
          ) {
            return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
          }
          const project = dependencies.database
            .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ?")
            .get(input.data.projectId);
          const existing = dependencies.database
            .query<{ id: string }, [string, string]>(
              "SELECT runner_id AS id FROM runner_mapping_versions WHERE runner_id = ? AND project_id = ? AND revoked_at IS NULL",
            )
            .get(input.data.runnerId, input.data.projectId);
          if (!project || existing)
            return failure(
              "RUNNER_MAPPING_CONFLICT",
              "Runner mapping conflicts with current state.",
            );
          const now = dependencies.clock();
          dependencies.database
            .query(
              `INSERT INTO runner_mapping_versions(
                 runner_id, project_id, revision, local_mapping_id, created_at
               ) VALUES (?, ?, 1, ?, ?)`,
            )
            .run(input.data.runnerId, input.data.projectId, input.data.localMappingId, now);
          const result = {
            ok: true,
            value: mappingView({
              runner_id: input.data.runnerId,
              project_id: input.data.projectId,
              revision: 1,
              local_mapping_id: input.data.localMappingId,
              created_at: now,
              revoked_at: null,
            }),
          } as const;
          return storeWrite(ticket, result, {
            auditKind: "RUNNER_MAPPING_REGISTERED",
            actorKind: "MEMBER",
            actorId: owner.member.memberId,
            subjectId: input.data.runnerId,
            safeDetails: {
              ownerMemberId: owner.member.memberId,
              projectId: input.data.projectId,
            },
          });
        });
      } catch {
        return failure("RUNNER_MAPPING_FAILED", "Runner mapping failed.");
      }
    },

    async replaceMapping(command) {
      const input = MappingBaseSchema.extend({ expectedRevision: PositiveRevisionSchema })
        .strict()
        .safeParse(command);
      if (!input.success) return failure("RUNNER_MAPPING_INVALID", "Runner mapping is invalid.");
      const owner = await activeOwner(input.data.actor as MemberActor, input.data.runnerId);
      if (!owner) {
        return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
      }
      const ticket = await writeTicket(
        "MAPPING_REPLACE",
        owner.member.memberId,
        input.data.idempotencyKey,
        {
          runnerId: input.data.runnerId,
          projectId: input.data.projectId,
          localMappingId: input.data.localMappingId,
          expectedRevision: input.data.expectedRevision,
        },
      );
      const prior = replayWrite<RunnerMapping>(ticket);
      if (prior) return prior;
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const raced = replayWrite<RunnerMapping>(ticket);
          if (raced) return raced;
          if (
            !revalidateOwner(
              input.data.actor as MemberActor,
              owner.member.proofHash,
              input.data.runnerId,
            )
          ) {
            return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
          }
          const now = dependencies.clock();
          const changed = dependencies.database
            .query(
              `UPDATE runner_mapping_versions SET revoked_at = ?
               WHERE runner_id = ? AND project_id = ? AND revision = ? AND revoked_at IS NULL`,
            )
            .run(now, input.data.runnerId, input.data.projectId, input.data.expectedRevision);
          if (changed.changes !== 1)
            return failure(
              "RUNNER_MAPPING_STALE",
              "Runner mapping revision is stale.",
              "SAME_INPUT",
            );
          const revision = input.data.expectedRevision + 1;
          dependencies.database
            .query(
              `INSERT INTO runner_mapping_versions(
                 runner_id, project_id, revision, local_mapping_id, created_at
               ) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              input.data.runnerId,
              input.data.projectId,
              revision,
              input.data.localMappingId,
              now,
            );
          const result = {
            ok: true,
            value: mappingView({
              runner_id: input.data.runnerId,
              project_id: input.data.projectId,
              revision,
              local_mapping_id: input.data.localMappingId,
              created_at: now,
              revoked_at: null,
            }),
          } as const;
          return storeWrite(ticket, result, {
            auditKind: "RUNNER_MAPPING_REPLACED",
            actorKind: "MEMBER",
            actorId: owner.member.memberId,
            subjectId: input.data.runnerId,
            safeDetails: {
              ownerMemberId: owner.member.memberId,
              projectId: input.data.projectId,
            },
          });
        });
      } catch {
        return failure("RUNNER_MAPPING_FAILED", "Runner mapping failed.");
      }
    },

    async revokeMapping(command) {
      const input = z
        .object({
          actor: MemberActorSchema,
          idempotencyKey: IdentifierSchema,
          runnerId: IdentifierSchema,
          projectId: IdentifierSchema,
          expectedRevision: PositiveRevisionSchema,
        })
        .strict()
        .safeParse(command);
      if (!input.success) return failure("RUNNER_MAPPING_INVALID", "Runner mapping is invalid.");
      const owner = await activeOwner(input.data.actor as MemberActor, input.data.runnerId);
      if (!owner) {
        return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
      }
      const ticket = await writeTicket(
        "MAPPING_REVOKE",
        owner.member.memberId,
        input.data.idempotencyKey,
        {
          runnerId: input.data.runnerId,
          projectId: input.data.projectId,
          expectedRevision: input.data.expectedRevision,
        },
      );
      const prior = replayWrite<RunnerMapping>(ticket);
      if (prior) return prior;
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const raced = replayWrite<RunnerMapping>(ticket);
          if (raced) return raced;
          if (
            !revalidateOwner(
              input.data.actor as MemberActor,
              owner.member.proofHash,
              input.data.runnerId,
            )
          ) {
            return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
          }
          const now = dependencies.clock();
          const changed = dependencies.database
            .query(
              `UPDATE runner_mapping_versions SET revoked_at = ?
               WHERE runner_id = ? AND project_id = ? AND revision = ? AND revoked_at IS NULL`,
            )
            .run(now, input.data.runnerId, input.data.projectId, input.data.expectedRevision);
          if (changed.changes !== 1)
            return failure("RUNNER_MAPPING_STALE", "Runner mapping revision is stale.");
          const row = dependencies.database
            .query<MappingRow, [string, string, number]>(
              "SELECT * FROM runner_mapping_versions WHERE runner_id = ? AND project_id = ? AND revision = ?",
            )
            .get(input.data.runnerId, input.data.projectId, input.data.expectedRevision);
          if (!row) return failure("RUNNER_MAPPING_FAILED", "Runner mapping failed.");
          const result = { ok: true as const, value: mappingView(row) };
          return storeWrite(ticket, result, {
            auditKind: "RUNNER_MAPPING_REVOKED",
            actorKind: "MEMBER",
            actorId: owner.member.memberId,
            subjectId: input.data.runnerId,
            safeDetails: {
              ownerMemberId: owner.member.memberId,
              projectId: input.data.projectId,
            },
          });
        });
      } catch {
        return failure("RUNNER_MAPPING_FAILED", "Runner mapping failed.");
      }
    },

    async advertiseProfile(command) {
      const input = ProfileSchema.safeParse(command);
      if (!input.success) return failure("RUNNER_PROFILE_INVALID", "Runner profile is invalid.");
      const owner = await activeOwner(input.data.actor as MemberActor, input.data.runnerId);
      if (!owner) {
        return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
      }
      const ticket = await writeTicket(
        "PROFILE_ADVERTISE",
        owner.member.memberId,
        input.data.idempotencyKey,
        {
          runnerId: input.data.runnerId,
          profileId: input.data.profileId,
          expectedVersion: input.data.expectedVersion,
          displayName: input.data.displayName,
          adapter: input.data.adapter,
          hosts: input.data.hosts,
          interactions: input.data.interactions,
          riskSummary: input.data.riskSummary,
          fingerprint: input.data.fingerprint,
        },
      );
      const prior = replayWrite<SafeProfileVersion>(ticket);
      if (prior) return prior;
      const profileId = input.data.profileId ?? dependencies.id("profile");
      const version = input.data.expectedVersion === undefined ? 1 : input.data.expectedVersion + 1;
      if (input.data.expectedVersion !== undefined) {
        const current = dependencies.database
          .query<{ version: number }, [string, string]>(
            "SELECT max(version) AS version FROM safe_profile_versions WHERE runner_id = ? AND profile_id = ?",
          )
          .get(input.data.runnerId, profileId)?.version;
        if (current !== input.data.expectedVersion) {
          return failure("RUNNER_PROFILE_STALE", "Runner profile version is stale.", "SAME_INPUT");
        }
      }
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const raced = replayWrite<SafeProfileVersion>(ticket);
          if (raced) return raced;
          if (
            !revalidateOwner(
              input.data.actor as MemberActor,
              owner.member.proofHash,
              input.data.runnerId,
            )
          ) {
            return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
          }
          const now = dependencies.clock();
          dependencies.database
            .query(
              `INSERT INTO safe_profile_versions(
               runner_id, profile_id, version, display_name, adapter, supports_native,
               supports_orca, supports_headless, supports_interactive, risk_summary,
               fingerprint, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.data.runnerId,
              profileId,
              version,
              input.data.displayName,
              input.data.adapter,
              input.data.hosts.includes("NATIVE") ? 1 : 0,
              input.data.hosts.includes("ORCA") ? 1 : 0,
              input.data.interactions.includes("HEADLESS") ? 1 : 0,
              input.data.interactions.includes("INTERACTIVE") ? 1 : 0,
              input.data.riskSummary,
              input.data.fingerprint,
              now,
            );
          const result = {
            ok: true as const,
            value: profileView({
              runner_id: input.data.runnerId,
              profile_id: profileId,
              version,
              display_name: input.data.displayName,
              adapter: input.data.adapter,
              supports_native: input.data.hosts.includes("NATIVE") ? 1 : 0,
              supports_orca: input.data.hosts.includes("ORCA") ? 1 : 0,
              supports_headless: input.data.interactions.includes("HEADLESS") ? 1 : 0,
              supports_interactive: input.data.interactions.includes("INTERACTIVE") ? 1 : 0,
              risk_summary: input.data.riskSummary,
              fingerprint: input.data.fingerprint,
              created_at: now,
            }),
          };
          return storeWrite(ticket, result, {
            auditKind: "RUNNER_PROFILE_ADVERTISED",
            actorKind: "MEMBER",
            actorId: owner.member.memberId,
            subjectId: input.data.runnerId,
            safeDetails: {
              ownerMemberId: owner.member.memberId,
              profileId,
              version,
            },
          });
        });
      } catch {
        return failure("RUNNER_PROFILE_FAILED", "Runner profile failed.");
      }
    },

    async previewExposureAcknowledgement(command) {
      const input = PreviewSchema.safeParse(command);
      if (!input.success) return failure("RUNNER_EXPOSURE_INVALID", "Runner exposure is invalid.");
      if (!(await activeOwner(input.data.actor as MemberActor, input.data.runnerId))) {
        return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
      }
      const subject = currentSubject(
        input.data.runnerId,
        input.data.projectId,
        input.data.mappingRevision,
        input.data.profileId,
        input.data.profileVersion,
      );
      if (!subject) return failure("RUNNER_EXPOSURE_STALE", "Runner exposure facts are stale.");
      const text = exposureAcknowledgementText(subject);
      return {
        ok: true,
        value: { subject, text, digest: exposureAcknowledgementDigest(subject, text) },
      };
    },

    async acknowledgeExposure(command) {
      const input = SubjectSchema.extend({
        idempotencyKey: IdentifierSchema,
        actor: MemberActorSchema,
        expectedDigest: Sha256Schema,
      })
        .strict()
        .safeParse(command);
      if (!input.success)
        return failure("RUNNER_ACKNOWLEDGEMENT_INVALID", "Runner acknowledgement is invalid.");
      const authority = await activeOwner(input.data.actor as MemberActor, input.data.runnerId);
      if (!authority) {
        return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
      }
      const submitted = SubjectSchema.parse({
        runnerId: input.data.runnerId,
        ownerMemberId: input.data.ownerMemberId,
        projectId: input.data.projectId,
        mappingRevision: input.data.mappingRevision,
        profileId: input.data.profileId,
        profileVersion: input.data.profileVersion,
        profileFingerprint: input.data.profileFingerprint,
        policyRevision: input.data.policyRevision,
        securityPolicyVersion: input.data.securityPolicyVersion,
        securityDigest: input.data.securityDigest,
      });
      const ticket = await writeTicket(
        "EXPOSURE_ACKNOWLEDGE",
        authority.member.memberId,
        input.data.idempotencyKey,
        { ...submitted, expectedDigest: input.data.expectedDigest },
      );
      const prior = replayWrite<ExposureAcknowledgement>(ticket);
      if (prior) return prior;
      const id = dependencies.id("runner_ack");
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const raced = replayWrite<ExposureAcknowledgement>(ticket);
          if (raced) return raced;
          if (
            !revalidateOwner(
              input.data.actor as MemberActor,
              authority.member.proofHash,
              input.data.runnerId,
            )
          ) {
            return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
          }
          const current = currentSubject(
            input.data.runnerId,
            input.data.projectId,
            input.data.mappingRevision,
            input.data.profileId,
            input.data.profileVersion,
          );
          if (!current || JSON.stringify(current) !== JSON.stringify(submitted)) {
            return failure(
              "RUNNER_ACKNOWLEDGEMENT_STALE",
              "Runner acknowledgement facts are stale.",
            );
          }
          const text = exposureAcknowledgementText(current);
          const expected = exposureAcknowledgementDigest(current, text);
          if (expected !== input.data.expectedDigest) {
            return failure(
              "RUNNER_ACKNOWLEDGEMENT_DIGEST_MISMATCH",
              "Runner acknowledgement digest does not match.",
            );
          }
          const now = dependencies.clock();
          dependencies.database
            .query(
              `INSERT INTO runner_exposure_acknowledgements(
                 id, version, runner_id, owner_member_id, project_id, mapping_revision,
                 profile_id, profile_version, profile_fingerprint, policy_revision,
                 security_policy_version, security_digest, acknowledgement_text,
                 acknowledgement_digest, accepted_at
               ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              current.runnerId,
              current.ownerMemberId,
              current.projectId,
              current.mappingRevision,
              current.profileId,
              current.profileVersion,
              current.profileFingerprint,
              current.policyRevision,
              current.securityPolicyVersion,
              current.securityDigest,
              text,
              expected,
              now,
            );
          const row = dependencies.database
            .query<AcknowledgementRow, [string]>(
              "SELECT * FROM runner_exposure_acknowledgements WHERE id = ?",
            )
            .get(id);
          if (!row) {
            return failure("RUNNER_ACKNOWLEDGEMENT_FAILED", "Runner acknowledgement failed.");
          }
          const result = { ok: true as const, value: acknowledgementView(row) };
          return storeWrite(ticket, result, {
            auditKind: "RUNNER_EXPOSURE_ACKNOWLEDGED",
            actorKind: "MEMBER",
            actorId: authority.member.memberId,
            subjectId: input.data.runnerId,
            safeDetails: {
              ownerMemberId: authority.member.memberId,
              projectId: input.data.projectId,
            },
          });
        });
      } catch {
        return failure("RUNNER_ACKNOWLEDGEMENT_FAILED", "Runner acknowledgement failed.");
      }
    },

    async revokeAcknowledgement(command) {
      const input = z
        .object({
          idempotencyKey: IdentifierSchema,
          actor: MemberActorSchema,
          acknowledgementId: IdentifierSchema,
          expectedVersion: PositiveRevisionSchema,
        })
        .strict()
        .safeParse(command);
      if (!input.success)
        return failure("RUNNER_ACKNOWLEDGEMENT_INVALID", "Runner acknowledgement is invalid.");
      const row = dependencies.database
        .query<AcknowledgementRow, [string]>(
          "SELECT * FROM runner_exposure_acknowledgements WHERE id = ?",
        )
        .get(input.data.acknowledgementId);
      const authority = row
        ? await activeOwner(input.data.actor as MemberActor, row.runner_id)
        : null;
      if (!row || !authority) {
        return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
      }
      const ticket = await writeTicket(
        "EXPOSURE_ACKNOWLEDGEMENT_REVOKE",
        authority.member.memberId,
        input.data.idempotencyKey,
        {
          acknowledgementId: input.data.acknowledgementId,
          expectedVersion: input.data.expectedVersion,
        },
      );
      const prior = replayWrite<ExposureAcknowledgement>(ticket);
      if (prior) return prior;
      return inImmediateTransaction(dependencies.database, () => {
        const raced = replayWrite<ExposureAcknowledgement>(ticket);
        if (raced) return raced;
        if (
          !revalidateOwner(
            input.data.actor as MemberActor,
            authority.member.proofHash,
            row.runner_id,
          )
        ) {
          return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
        }
        const now = dependencies.clock();
        const changed = dependencies.database
          .query(
            "UPDATE runner_exposure_acknowledgements SET revoked_at = ? WHERE id = ? AND version = ? AND revoked_at IS NULL",
          )
          .run(now, row.id, input.data.expectedVersion);
        if (changed.changes !== 1) {
          return failure("RUNNER_ACKNOWLEDGEMENT_STALE", "Runner acknowledgement facts are stale.");
        }
        const result = {
          ok: true as const,
          value: acknowledgementView({ ...row, revoked_at: now }),
        };
        return storeWrite(ticket, result, {
          auditKind: "RUNNER_EXPOSURE_ACKNOWLEDGEMENT_REVOKED",
          actorKind: "MEMBER",
          actorId: authority.member.memberId,
          subjectId: row.runner_id,
          safeDetails: { ownerMemberId: authority.member.memberId, acknowledgementId: row.id },
        });
      });
    },

    async createExposure(command) {
      const input = z
        .object({
          idempotencyKey: IdentifierSchema,
          actor: MemberActorSchema,
          acknowledgementId: IdentifierSchema,
        })
        .strict()
        .safeParse(command);
      if (!input.success) return failure("RUNNER_EXPOSURE_INVALID", "Runner exposure is invalid.");
      const acknowledgement = dependencies.database
        .query<AcknowledgementRow, [string]>(
          "SELECT * FROM runner_exposure_acknowledgements WHERE id = ?",
        )
        .get(input.data.acknowledgementId);
      const authority = acknowledgement
        ? await activeOwner(input.data.actor as MemberActor, acknowledgement.runner_id)
        : null;
      if (!acknowledgement || !authority) {
        return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
      }
      const ticket = await writeTicket(
        "EXPOSURE_CREATE",
        authority.member.memberId,
        input.data.idempotencyKey,
        { acknowledgementId: input.data.acknowledgementId },
      );
      const prior = replayWrite<TeamDispatchExposure>(ticket);
      if (prior) return prior;
      const id = dependencies.id("runner_exposure");
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const raced = replayWrite<TeamDispatchExposure>(ticket);
          if (raced) return raced;
          const runner = revalidateOwner(
            input.data.actor as MemberActor,
            authority.member.proofHash,
            acknowledgement.runner_id,
          );
          const current = currentSubject(
            acknowledgement.runner_id,
            acknowledgement.project_id,
            acknowledgement.mapping_revision,
            acknowledgement.profile_id,
            acknowledgement.profile_version,
          );
          if (
            !runner ||
            acknowledgement.revoked_at !== null ||
            !current ||
            JSON.stringify(current) !==
              JSON.stringify({
                runnerId: acknowledgement.runner_id,
                ownerMemberId: acknowledgement.owner_member_id,
                projectId: acknowledgement.project_id,
                mappingRevision: acknowledgement.mapping_revision,
                profileId: acknowledgement.profile_id,
                profileVersion: acknowledgement.profile_version,
                profileFingerprint: acknowledgement.profile_fingerprint,
                policyRevision: acknowledgement.policy_revision,
                securityPolicyVersion: acknowledgement.security_policy_version,
                securityDigest: acknowledgement.security_digest,
              }) ||
            runner.dispatch_audience !== "TEAM"
          ) {
            return failure("RUNNER_EXPOSURE_STALE", "Runner exposure facts are stale.");
          }
          const now = dependencies.clock();
          dependencies.database
            .query(
              `INSERT INTO runner_exposures(
                 id, runner_id, owner_member_id, project_id, mapping_revision, profile_id,
                 profile_version, profile_fingerprint, policy_revision, security_policy_version,
                 security_digest, acknowledgement_id, revision, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            )
            .run(
              id,
              acknowledgement.runner_id,
              acknowledgement.owner_member_id,
              acknowledgement.project_id,
              acknowledgement.mapping_revision,
              acknowledgement.profile_id,
              acknowledgement.profile_version,
              acknowledgement.profile_fingerprint,
              acknowledgement.policy_revision,
              acknowledgement.security_policy_version,
              acknowledgement.security_digest,
              acknowledgement.id,
              now,
            );
          const row = dependencies.database
            .query<ExposureRow, [string]>("SELECT * FROM runner_exposures WHERE id = ?")
            .get(id);
          if (!row) return failure("RUNNER_EXPOSURE_FAILED", "Runner exposure failed.");
          const result = { ok: true as const, value: exposureView(row) };
          return storeWrite(ticket, result, {
            auditKind: "RUNNER_EXPOSURE_CREATED",
            actorKind: "MEMBER",
            actorId: authority.member.memberId,
            subjectId: acknowledgement.runner_id,
            safeDetails: {
              ownerMemberId: authority.member.memberId,
              projectId: acknowledgement.project_id,
            },
          });
        });
      } catch {
        return failure("RUNNER_EXPOSURE_FAILED", "Runner exposure failed.");
      }
    },

    async revokeExposure(command) {
      const input = z
        .object({
          actor: MemberActorSchema,
          idempotencyKey: IdentifierSchema,
          exposureId: IdentifierSchema,
          expectedRevision: PositiveRevisionSchema,
        })
        .strict()
        .safeParse(command);
      if (!input.success) return failure("RUNNER_EXPOSURE_INVALID", "Runner exposure is invalid.");
      const row = dependencies.database
        .query<ExposureRow, [string]>("SELECT * FROM runner_exposures WHERE id = ?")
        .get(input.data.exposureId);
      const authority = row
        ? await activeOwner(input.data.actor as MemberActor, row.runner_id)
        : null;
      if (!row || !authority) {
        return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
      }
      const ticket = await writeTicket(
        "EXPOSURE_REVOKE",
        authority.member.memberId,
        input.data.idempotencyKey,
        { exposureId: input.data.exposureId, expectedRevision: input.data.expectedRevision },
      );
      const prior = replayWrite<TeamDispatchExposure>(ticket);
      if (prior) return prior;
      return inImmediateTransaction(dependencies.database, () => {
        const raced = replayWrite<TeamDispatchExposure>(ticket);
        if (raced) return raced;
        if (
          !revalidateOwner(
            input.data.actor as MemberActor,
            authority.member.proofHash,
            row.runner_id,
          )
        ) {
          return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
        }
        const now = dependencies.clock();
        const changed = dependencies.database
          .query(
            "UPDATE runner_exposures SET revoked_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND revoked_at IS NULL",
          )
          .run(now, row.id, input.data.expectedRevision);
        if (changed.changes !== 1) {
          return failure("RUNNER_EXPOSURE_STALE", "Runner exposure revision is stale.");
        }
        const result = {
          ok: true as const,
          value: exposureView({ ...row, revision: row.revision + 1, revoked_at: now }),
        };
        return storeWrite(ticket, result, {
          auditKind: "RUNNER_EXPOSURE_REVOKED",
          actorKind: "MEMBER",
          actorId: authority.member.memberId,
          subjectId: row.runner_id,
          safeDetails: { ownerMemberId: authority.member.memberId, exposureId: row.id },
        });
      });
    },

    async heartbeat(command) {
      const input = z
        .object({
          idempotencyKey: IdentifierSchema,
          principal: z
            .object({
              kind: z.literal("VERIFIED_RUNNER"),
              runnerId: IdentifierSchema,
              runnerEpoch: PositiveRevisionSchema,
              ownerMemberId: IdentifierSchema,
              keyThumbprint: IdentifierSchema,
              accessExpiresAt: z.number().int().nonnegative(),
            })
            .strict(),
          repositoryObservations: z
            .array(
              z
                .object({
                  projectId: IdentifierSchema,
                  mappingRevision: PositiveRevisionSchema,
                  baseBranch: GitRefSchema,
                  baseCommit: CommitShaSchema,
                })
                .strict(),
            )
            .max(128)
            .default([]),
        })
        .strict()
        .safeParse(command);
      if (!input.success || dependencies.clock() >= input.data.principal.accessExpiresAt) {
        return failure("RUNNER_AUTHENTICATION_INVALID", "Runner authentication is invalid.");
      }
      const ticket = await writeTicket(
        "HEARTBEAT",
        input.data.principal.runnerId,
        input.data.idempotencyKey,
        {
          runnerId: input.data.principal.runnerId,
          runnerEpoch: input.data.principal.runnerEpoch,
          accessExpiresAt: input.data.principal.accessExpiresAt,
          repositoryObservations: input.data.repositoryObservations,
        },
      );
      const prior = replayWrite<RunnerLeaseView>(ticket);
      if (prior) return prior;
      return inImmediateTransaction(dependencies.database, () => {
        const raced = replayWrite<RunnerLeaseView>(ticket);
        if (raced) return raced;
        const now = dependencies.clock();
        if (now >= input.data.principal.accessExpiresAt) {
          return failure("RUNNER_AUTHENTICATION_INVALID", "Runner authentication is invalid.");
        }
        const observationKeys = new Set<string>();
        for (const observation of input.data.repositoryObservations) {
          const observationKey = `${observation.projectId}\0${observation.mappingRevision}`;
          const mapping = dependencies.database
            .query<{ base_branch: string }, [string, string, number]>(
              `SELECT projects.base_branch
               FROM runner_mapping_versions AS mappings
               JOIN projects ON projects.id = mappings.project_id
               WHERE mappings.runner_id = ? AND mappings.project_id = ?
                 AND mappings.revision = ? AND mappings.revoked_at IS NULL`,
            )
            .get(input.data.principal.runnerId, observation.projectId, observation.mappingRevision);
          if (
            observationKeys.has(observationKey) ||
            !mapping ||
            mapping.base_branch !== observation.baseBranch
          )
            return failure(
              "RUNNER_REPOSITORY_OBSERVATION_INVALID",
              "Runner repository observation is invalid.",
            );
          observationKeys.add(observationKey);
        }
        const changed = dependencies.database
          .query(
            `UPDATE runners SET last_heartbeat_at = ?
             WHERE id = ? AND runner_epoch = ? AND owner_member_id = ? AND revoked_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM members
                 WHERE members.id = runners.owner_member_id AND members.status = 'ACTIVE'
               )`,
          )
          .run(
            now,
            input.data.principal.runnerId,
            input.data.principal.runnerEpoch,
            input.data.principal.ownerMemberId,
          );
        if (changed.changes !== 1) {
          return failure("RUNNER_AUTHENTICATION_INVALID", "Runner authentication is invalid.");
        }
        for (const observation of input.data.repositoryObservations) {
          dependencies.database
            .query(
              `INSERT INTO runner_repository_observations(
                 runner_id, runner_epoch, project_id, mapping_revision,
                 base_branch, base_commit, observed_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(runner_id, project_id, mapping_revision) DO UPDATE SET
                 runner_epoch = excluded.runner_epoch,
                 base_branch = excluded.base_branch,
                 base_commit = excluded.base_commit,
                 observed_at = excluded.observed_at`,
            )
            .run(
              input.data.principal.runnerId,
              input.data.principal.runnerEpoch,
              observation.projectId,
              observation.mappingRevision,
              observation.baseBranch,
              observation.baseCommit,
              now,
            );
        }
        const result = { ok: true as const, value: inspectLease(input.data.principal.runnerId) };
        return storeWrite(ticket, result, {
          auditKind: "RUNNER_HEARTBEAT_ACCEPTED",
          actorKind: "RUNNER",
          actorId: input.data.principal.runnerId,
          subjectId: input.data.principal.runnerId,
          safeDetails: {
            ownerMemberId: input.data.principal.ownerMemberId,
            runnerEpoch: input.data.principal.runnerEpoch,
            repositoryObservationCount: input.data.repositoryObservations.length,
          },
        });
      });
    },

    async revoke(command) {
      const input = z
        .object({
          idempotencyKey: IdentifierSchema,
          actor: MemberActorSchema,
          runnerId: IdentifierSchema,
          expectedRunnerEpoch: PositiveRevisionSchema,
        })
        .strict()
        .safeParse(command);
      if (!input.success)
        return failure("RUNNER_REVOCATION_INVALID", "Runner revocation is invalid.");
      const member = await memberAuthority(input.data.actor as MemberActor);
      const runner = runnerById(input.data.runnerId);
      if (!member || !runner || runner.owner_member_id !== member.memberId) {
        return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
      }
      const ticket = await writeTicket(
        "RUNNER_REVOKE",
        member.memberId,
        input.data.idempotencyKey,
        { runnerId: input.data.runnerId, expectedRunnerEpoch: input.data.expectedRunnerEpoch },
      );
      const prior = replayWrite<RunnerRevocation>(ticket);
      if (prior) return prior;
      if (runner.revoked_at !== null) {
        return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
      }
      const now = dependencies.clock();
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const raced = replayWrite<RunnerRevocation>(ticket);
          if (raced) return raced;
          if (
            !revalidateOwner(input.data.actor as MemberActor, member.proofHash, input.data.runnerId)
          ) {
            return failure("RUNNER_OWNER_REQUIRED", "Runner owner authorization is required.");
          }
          const nextEpoch = input.data.expectedRunnerEpoch + 1;
          const changed = dependencies.database
            .query(
              `UPDATE runners SET runner_epoch = ?, revision = revision + 1, revoked_at = ?
               WHERE id = ? AND runner_epoch = ? AND revoked_at IS NULL`,
            )
            .run(nextEpoch, now, input.data.runnerId, input.data.expectedRunnerEpoch);
          if (changed.changes !== 1) return failure("RUNNER_EPOCH_STALE", "Runner epoch is stale.");
          for (const statement of [
            "UPDATE runner_credentials SET revoked_at = ?, revision = revision + 1 WHERE runner_id = ? AND revoked_at IS NULL",
            "UPDATE runner_mapping_versions SET revoked_at = ? WHERE runner_id = ? AND revoked_at IS NULL",
            "UPDATE runner_exposure_acknowledgements SET revoked_at = ? WHERE runner_id = ? AND revoked_at IS NULL",
            "UPDATE runner_exposures SET revoked_at = ?, revision = revision + 1 WHERE runner_id = ? AND revoked_at IS NULL",
          ]) {
            dependencies.database.query(statement).run(now, input.data.runnerId);
          }
          dependencies.database
            .query(
              `INSERT INTO runner_authority_change_outbox(
                 id, runner_id, cause, runner_epoch, status, created_at
               ) VALUES (?, ?, 'DIRECT_REVOCATION', ?, 'PENDING', ?)`,
            )
            .run(dependencies.id("runner_authority"), input.data.runnerId, nextEpoch, now);
          const result = {
            ok: true,
            value: {
              runnerId: input.data.runnerId as RegisteredRunnerId,
              runnerEpoch: nextEpoch,
              disposition: "REVOKED" as const,
              revokedAt: now,
            },
          } as const;
          return storeWrite(ticket, result, {
            auditKind: "RUNNER_REVOKED",
            actorKind: "MEMBER",
            actorId: member.memberId,
            subjectId: input.data.runnerId,
            safeDetails: {
              ownerMemberId: member.memberId,
              runnerEpoch: nextEpoch,
            },
          });
        });
      } catch {
        return failure("RUNNER_REVOCATION_FAILED", "Runner revocation failed.");
      }
    },

    async inspectEligibility(command) {
      const input = z
        .object({
          actor: MemberActorSchema,
          runnerId: IdentifierSchema,
          projectId: IdentifierSchema,
          mappingRevision: PositiveRevisionSchema,
          profileId: IdentifierSchema,
          profileVersion: PositiveRevisionSchema,
          exposureId: IdentifierSchema.optional(),
        })
        .strict()
        .safeParse(command);
      if (!input.success)
        return failure("RUNNER_ELIGIBILITY_INVALID", "Runner eligibility input is invalid.");
      const member = await memberAuthority(input.data.actor as MemberActor);
      if (!member) return failure("RUNNER_NOT_OWNED_OR_EXPOSED", "Runner is not owned or exposed.");
      const owner = Boolean(
        dependencies.database
          .query<{ id: string }, [string, string]>(
            "SELECT id FROM runners WHERE id = ? AND owner_member_id = ?",
          )
          .get(input.data.runnerId, member.memberId),
      );
      if (!owner) {
        const exposed = dependencies.database
          .query<
            {
              runner_epoch: number;
              policy_revision: number;
              last_heartbeat_at: number | null;
              mapping_revision: number;
              profile_id: string;
              profile_version: number;
              profile_fingerprint: string;
              exposure_revision: number;
              acknowledgement_version: number;
            },
            [string, string, number, string, number, string, string]
          >(
            `SELECT runners.runner_epoch, runners.policy_revision, runners.last_heartbeat_at,
                    mappings.revision AS mapping_revision, profiles.profile_id,
                    profiles.version AS profile_version,
                    profiles.fingerprint AS profile_fingerprint,
                    exposures.revision AS exposure_revision,
                    acknowledgements.version AS acknowledgement_version
             FROM runner_exposures AS exposures
             JOIN runners ON runners.id = exposures.runner_id
             JOIN runner_mapping_versions AS mappings
               ON mappings.runner_id = exposures.runner_id
              AND mappings.project_id = exposures.project_id
              AND mappings.revision = exposures.mapping_revision
             JOIN safe_profile_versions AS profiles
               ON profiles.runner_id = exposures.runner_id
              AND profiles.profile_id = exposures.profile_id
              AND profiles.version = exposures.profile_version
             JOIN runner_exposure_acknowledgements AS acknowledgements
               ON acknowledgements.id = exposures.acknowledgement_id
             WHERE exposures.runner_id = ? AND exposures.project_id = ?
               AND exposures.mapping_revision = ? AND exposures.profile_id = ?
               AND exposures.profile_version = ? AND exposures.revoked_at IS NULL
               AND mappings.revoked_at IS NULL AND acknowledgements.revoked_at IS NULL
               AND runners.revoked_at IS NULL AND runners.dispatch_audience = 'TEAM'
               AND exposures.owner_member_id = runners.owner_member_id
               AND exposures.policy_revision = runners.policy_revision
               AND exposures.security_policy_version = runners.security_policy_version
               AND exposures.security_digest = runners.security_digest
               AND acknowledgements.runner_id = exposures.runner_id
               AND acknowledgements.owner_member_id = exposures.owner_member_id
               AND acknowledgements.project_id = exposures.project_id
               AND acknowledgements.mapping_revision = exposures.mapping_revision
               AND acknowledgements.profile_id = exposures.profile_id
               AND acknowledgements.profile_version = exposures.profile_version
               AND acknowledgements.profile_fingerprint = exposures.profile_fingerprint
               AND acknowledgements.policy_revision = exposures.policy_revision
               AND acknowledgements.security_policy_version = exposures.security_policy_version
               AND acknowledgements.security_digest = exposures.security_digest
               AND profiles.fingerprint = exposures.profile_fingerprint
               AND NOT EXISTS (
                 SELECT 1 FROM safe_profile_versions AS newer
                 WHERE newer.runner_id = profiles.runner_id
                   AND newer.profile_id = profiles.profile_id
                   AND newer.version > profiles.version
               )
               AND (? = '' OR exposures.id = ?)`,
          )
          .get(
            input.data.runnerId,
            input.data.projectId,
            input.data.mappingRevision,
            input.data.profileId,
            input.data.profileVersion,
            input.data.exposureId ?? "",
            input.data.exposureId ?? "",
          );
        if (!exposed) {
          return failure("RUNNER_NOT_OWNED_OR_EXPOSED", "Runner is not owned or exposed.");
        }
        const observedAt = dependencies.clock();
        const state =
          exposed.last_heartbeat_at === null
            ? "NEVER_CONNECTED"
            : observedAt - exposed.last_heartbeat_at < 30
              ? "ONLINE"
              : "OFFLINE";
        return {
          ok: true,
          value: {
            disposition: "CURRENT",
            authorizationSource: "TEAM_EXPOSURE",
            runnerEpoch: exposed.runner_epoch,
            policyRevision: exposed.policy_revision,
            mappingRevision: exposed.mapping_revision,
            profileId: exposed.profile_id as SafeProfileId,
            profileVersion: exposed.profile_version,
            profileFingerprint: exposed.profile_fingerprint,
            exposureRevision: exposed.exposure_revision,
            acknowledgementVersion: exposed.acknowledgement_version,
            lease: {
              runnerId: input.data.runnerId as RegisteredRunnerId,
              runnerEpoch: exposed.runner_epoch,
              state,
              ...(exposed.last_heartbeat_at === null
                ? {}
                : { lastHeartbeatAt: exposed.last_heartbeat_at }),
              observedAt,
            },
            staleReasons: [],
          } satisfies RunnerEligibilityFacts,
        };
      }
      const runner = runnerById(input.data.runnerId);
      if (!runner) {
        return failure("RUNNER_NOT_OWNED_OR_EXPOSED", "Runner is not owned or exposed.");
      }
      const exposure = dependencies.database
        .query<ExposureRow, [string, string, number, string, number]>(
          `SELECT * FROM runner_exposures
           WHERE runner_id = ? AND project_id = ? AND mapping_revision = ?
             AND profile_id = ? AND profile_version = ?
             ${owner ? "" : "AND revoked_at IS NULL"}
           ORDER BY revision DESC LIMIT 1`,
        )
        .get(
          input.data.runnerId,
          input.data.projectId,
          input.data.mappingRevision,
          input.data.profileId,
          input.data.profileVersion,
        );
      if (
        !owner &&
        (!exposure || (input.data.exposureId && exposure.id !== input.data.exposureId))
      ) {
        return failure("RUNNER_NOT_OWNED_OR_EXPOSED", "Runner is not owned or exposed.");
      }
      const mapping = dependencies.database
        .query<MappingRow, [string, string, number]>(
          "SELECT * FROM runner_mapping_versions WHERE runner_id = ? AND project_id = ? AND revision = ?",
        )
        .get(input.data.runnerId, input.data.projectId, input.data.mappingRevision);
      const profile = dependencies.database
        .query<ProfileRow, [string, string, number]>(
          "SELECT * FROM safe_profile_versions WHERE runner_id = ? AND profile_id = ? AND version = ?",
        )
        .get(input.data.runnerId, input.data.profileId, input.data.profileVersion);
      if (!mapping || !profile) {
        return owner
          ? failure("RUNNER_ELIGIBILITY_STALE", "Runner eligibility facts are stale.")
          : failure("RUNNER_NOT_OWNED_OR_EXPOSED", "Runner is not owned or exposed.");
      }
      const latestProfile = dependencies.database
        .query<{ version: number }, [string, string]>(
          "SELECT max(version) AS version FROM safe_profile_versions WHERE runner_id = ? AND profile_id = ?",
        )
        .get(input.data.runnerId, input.data.profileId)?.version;
      const acknowledgement = exposure
        ? dependencies.database
            .query<AcknowledgementRow, [string]>(
              "SELECT * FROM runner_exposure_acknowledgements WHERE id = ?",
            )
            .get(exposure.acknowledgement_id)
        : undefined;
      const staleReasons: string[] = [];
      if (runner.revoked_at !== null) staleReasons.push("RUNNER_REVOKED");
      if (mapping.revoked_at !== null) staleReasons.push("MAPPING_REVOKED");
      if (latestProfile !== profile.version) staleReasons.push("PROFILE_VERSION_STALE");
      if (!owner) {
        if (runner.dispatch_audience !== "TEAM") staleReasons.push("AUDIENCE_NOT_TEAM");
        if (exposure?.revoked_at !== null) staleReasons.push("EXPOSURE_REVOKED");
        if (acknowledgement?.revoked_at !== null) staleReasons.push("ACKNOWLEDGEMENT_REVOKED");
        if (exposure?.policy_revision !== runner.policy_revision)
          staleReasons.push("POLICY_REVISION_STALE");
        if (exposure?.security_policy_version !== runner.security_policy_version)
          staleReasons.push("SECURITY_POLICY_STALE");
        if (exposure?.security_digest !== runner.security_digest)
          staleReasons.push("SECURITY_DIGEST_STALE");
      }
      return {
        ok: true,
        value: {
          disposition: staleReasons.length === 0 ? "CURRENT" : "STALE",
          authorizationSource: owner ? "OWNER" : "TEAM_EXPOSURE",
          runnerEpoch: runner.runner_epoch,
          policyRevision: runner.policy_revision,
          mappingRevision: mapping.revision,
          profileId: profile.profile_id as SafeProfileId,
          profileVersion: profile.version,
          profileFingerprint: profile.fingerprint,
          ...(exposure ? { exposureRevision: exposure.revision } : {}),
          ...(acknowledgement ? { acknowledgementVersion: acknowledgement.version } : {}),
          lease: inspectLease(runner.id),
          staleReasons,
        } satisfies RunnerEligibilityFacts,
      };
    },

    inspectLease,
  };

  const policyFactsStore: RunnerPolicyFactsStore = {
    replaceForAuthority(command) {
      if (
        !validRunnerId(command.runnerId) ||
        !Number.isInteger(command.expectedPolicyRevision) ||
        command.expectedPolicyRevision < 1 ||
        !["OWNER_ONLY", "TEAM"].includes(command.audience) ||
        !Number.isInteger(command.maximumConcurrentAttempts) ||
        command.maximumConcurrentAttempts < 1 ||
        command.maximumConcurrentAttempts > 32
      ) {
        throw new Error("RUNNER_POLICY_INVALID");
      }
      return inImmediateTransaction(dependencies.database, () => {
        const next = command.expectedPolicyRevision + 1;
        const changed = dependencies.database
          .query(
            `UPDATE runners SET dispatch_audience = ?, maximum_concurrent_attempts = ?,
               policy_revision = ?, revision = revision + 1
             WHERE id = ? AND policy_revision = ? AND revoked_at IS NULL`,
          )
          .run(
            command.audience,
            command.maximumConcurrentAttempts,
            next,
            command.runnerId,
            command.expectedPolicyRevision,
          );
        if (changed.changes !== 1) throw new Error("RUNNER_POLICY_STALE");
        return {
          runnerId: command.runnerId,
          audience: command.audience,
          maximumConcurrentAttempts: command.maximumConcurrentAttempts,
          policyRevision: next,
        } as RunnerPolicyFacts;
      });
    },
  };

  return {
    registry,
    policyFactsStore,
    authentication: createRunnerAuthenticationAuthority({
      database: dependencies.database,
      clock: dependencies.clock,
      randomSecret,
      digest,
      runnerKeyProof: dependencies.runnerKeyProof,
      runnerRequestProof: dependencies.runnerRequestProof,
    }),
  };
}
