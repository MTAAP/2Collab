import { z } from "zod";
import type { MemberActor, VerifiedDevicePrincipal, VerifiedRunnerPrincipal } from "./actors.ts";
import type {
  CommitSha,
  ConnectedRepositoryId,
  CustomLaunchProfileVersionId,
  ExposureAcknowledgementId,
  MemberId,
  ProjectId,
  RegisteredRunnerId,
  SafeProfileId,
} from "./ids.ts";
import { CommitShaSchema, IdentifierSchema, RevisionSchema } from "./ids.ts";

const forbiddenGitRefCharacters = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  });
}

function isNormalizedGitRef(value: string): boolean {
  if (
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    hasControlCharacter(value) ||
    [...value].some((character) => forbiddenGitRefCharacters.has(character))
  ) {
    return false;
  }
  return value
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

export const GitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isNormalizedGitRef, "Invalid git ref");
export const RepositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith("-") &&
      !/^[A-Za-z]:\//.test(value) &&
      !value.includes("\\") &&
      !hasControlCharacter(value) &&
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "Invalid repository-relative path",
  );

export type RepositoryMode = "MUTATING" | "INSPECT_ONLY";
export type RepositoryAssurance = "ADVISORY" | "ENFORCED";
export type ExecutionHost = "NATIVE" | "ORCA";
export type InteractionMode = "HEADLESS" | "INTERACTIVE";

export type RepositoryRequest = Readonly<{
  repositoryId: ConnectedRepositoryId;
  mode: RepositoryMode;
  assurance: RepositoryAssurance;
  base:
    | Readonly<{ kind: "EXACT"; commitSha: CommitSha }>
    | Readonly<{ kind: "RESOLVE_DEFAULT_BASE" }>;
  intendedBranch?: string;
}>;

export type ExecutionSelection = Readonly<{
  runnerId: RegisteredRunnerId;
  expectedRunnerEpoch: number;
  projectMappingRevision: number;
  profileVersionId: CustomLaunchProfileVersionId;
  expectedProfileVersion: number;
  exposureRevision?: number;
  host: ExecutionHost;
  interaction: InteractionMode;
}>;

export type RunnerPolicyReplacement = Readonly<{
  audience: "OWNER_ONLY" | "TEAM";
  maximumConcurrentAttempts: number;
}>;

export type EligibleTarget = Readonly<{
  runnerId: RegisteredRunnerId;
  profileVersionId: CustomLaunchProfileVersionId;
  host: ExecutionHost;
  interaction: InteractionMode;
  assurance: RepositoryAssurance;
}>;

export const RepositoryRequestSchema = z
  .object({
    repositoryId: IdentifierSchema,
    mode: z.enum(["MUTATING", "INSPECT_ONLY"]),
    assurance: z.enum(["ADVISORY", "ENFORCED"]),
    base: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("EXACT"), commitSha: CommitShaSchema }).strict(),
      z.object({ kind: z.literal("RESOLVE_DEFAULT_BASE") }).strict(),
    ]),
    intendedBranch: GitRefSchema.optional(),
  })
  .strict();

export const ExecutionSelectionSchema = z
  .object({
    runnerId: IdentifierSchema,
    expectedRunnerEpoch: RevisionSchema,
    projectMappingRevision: RevisionSchema,
    profileVersionId: IdentifierSchema,
    expectedProfileVersion: z.number().int().positive(),
    exposureRevision: RevisionSchema.optional(),
    host: z.enum(["NATIVE", "ORCA"]),
    interaction: z.enum(["HEADLESS", "INTERACTIVE"]),
  })
  .strict();

export const EligibleTargetSchema = z
  .object({
    runnerId: IdentifierSchema,
    profileVersionId: IdentifierSchema,
    host: z.enum(["NATIVE", "ORCA"]),
    interaction: z.enum(["HEADLESS", "INTERACTIVE"]),
    assurance: z.enum(["ADVISORY", "ENFORCED"]),
  })
  .strict();

export type RunnerDispatchAudience = "OWNER_ONLY" | "TEAM";
export type RunnerAdapter = "CLAUDE" | "CODEX" | "PI" | "OPENCODE";
export type RunnerLeaseState = "NEVER_CONNECTED" | "ONLINE" | "OFFLINE" | "REVOKED";

export type RunnerView = Readonly<{
  runnerId: RegisteredRunnerId;
  ownerMemberId: MemberId;
  runnerEpoch: number;
  policyRevision: number;
  audience: RunnerDispatchAudience;
  maximumConcurrentAttempts: number;
  securityPolicyVersion: number;
  securityDigest: string;
  revision: number;
  createdAt: number;
  revokedAt?: number;
}>;

export type RunnerPairingChallenge = Readonly<{
  pairingId: string;
  pairingSecret: string;
  expiresAt: number;
}>;
export type ConfirmedRunnerPairing = Readonly<{ pairingId: string; confirmedAt: number }>;
export type RunnerCredentialEnvelope = Readonly<{
  runnerId: RegisteredRunnerId;
  runnerEpoch: number;
  ownerMemberId: MemberId;
  runnerCredential: string;
  keyThumbprint: string;
}>;
export type RunnerMapping = Readonly<{
  runnerId: RegisteredRunnerId;
  projectId: ProjectId;
  revision: number;
  localMappingId: string;
  createdAt: number;
  revokedAt?: number;
}>;
export type SafeProfileVersion = Readonly<{
  runnerId: RegisteredRunnerId;
  profileId: SafeProfileId;
  displayName: string;
  adapter: RunnerAdapter;
  hosts: readonly ExecutionHost[];
  interactions: readonly InteractionMode[];
  riskSummary: string;
  version: number;
  fingerprint: string;
  createdAt: number;
}>;

export type ExposureSubject = Readonly<{
  runnerId: RegisteredRunnerId;
  ownerMemberId: MemberId;
  projectId: ProjectId;
  mappingRevision: number;
  profileId: SafeProfileId;
  profileVersion: number;
  profileFingerprint: string;
  policyRevision: number;
  securityPolicyVersion: number;
  securityDigest: string;
}>;
export type ExposureAcknowledgementPreview = Readonly<{
  subject: ExposureSubject;
  text: string;
  digest: string;
}>;
export type ExposureAcknowledgement = ExposureSubject &
  Readonly<{
    id: ExposureAcknowledgementId;
    version: number;
    text: string;
    digest: string;
    acceptedAt: number;
    revokedAt?: number;
  }>;
export type TeamDispatchExposure = ExposureSubject &
  Readonly<{
    id: string;
    acknowledgementId: ExposureAcknowledgementId;
    revision: number;
    createdAt: number;
    revokedAt?: number;
  }>;

export type RunnerLeaseView = Readonly<{
  runnerId: RegisteredRunnerId;
  runnerEpoch: number;
  state: RunnerLeaseState;
  lastHeartbeatAt?: number;
  observedAt: number;
}>;
export type RunnerRevocation = Readonly<{
  runnerId: RegisteredRunnerId;
  runnerEpoch: number;
  disposition: "REVOKED";
  revokedAt: number;
}>;
export type RunnerEligibilityFacts = Readonly<{
  disposition: "CURRENT" | "STALE";
  authorizationSource: "OWNER" | "TEAM_EXPOSURE";
  runnerEpoch: number;
  policyRevision: number;
  mappingRevision: number;
  profileId: SafeProfileId;
  profileVersion: number;
  profileFingerprint: string;
  exposureRevision?: number;
  acknowledgementVersion?: number;
  lease: RunnerLeaseView;
  staleReasons: readonly string[];
}>;

export type RunnerAccessIssue = Readonly<{
  accessToken: string;
  nonce: string;
  runnerId: RegisteredRunnerId;
  runnerEpoch: number;
  keyThumbprint: string;
  expiresAt: number;
}>;

export type BeginRunnerPairing = Readonly<{
  idempotencyKey: string;
  principal: VerifiedDevicePrincipal;
}>;
export type ConfirmRunnerPairing = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  pairingId: string;
}>;
export type ConsumeRunnerPairing = Readonly<{
  idempotencyKey: string;
  pairingSecret: string;
  keyId: string;
  keyProof: string;
}>;
export type RegisterRunnerMapping = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  runnerId: RegisteredRunnerId;
  projectId: ProjectId;
  localMappingId: string;
}>;
export type ReplaceRunnerMapping = RegisterRunnerMapping & Readonly<{ expectedRevision: number }>;
export type RevokeRunnerMapping = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  runnerId: RegisteredRunnerId;
  projectId: ProjectId;
  expectedRevision: number;
}>;
export type AdvertiseSafeProfileVersion = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  runnerId: RegisteredRunnerId;
  profileId?: SafeProfileId;
  expectedVersion?: number;
  displayName: string;
  adapter: RunnerAdapter;
  hosts: readonly ExecutionHost[];
  interactions: readonly InteractionMode[];
  riskSummary: string;
  fingerprint: string;
}>;
export type PreviewExposureAcknowledgement = Readonly<{
  actor: MemberActor;
  runnerId: RegisteredRunnerId;
  projectId: ProjectId;
  mappingRevision: number;
  profileId: SafeProfileId;
  profileVersion: number;
}>;
export type AcknowledgeTeamExposure = ExposureSubject &
  Readonly<{ idempotencyKey: string; actor: MemberActor; expectedDigest: string }>;
export type RevokeExposureAcknowledgement = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  acknowledgementId: ExposureAcknowledgementId;
  expectedVersion: number;
}>;
export type CreateTeamExposure = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  acknowledgementId: ExposureAcknowledgementId;
}>;
export type RevokeTeamExposure = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  exposureId: string;
  expectedRevision: number;
}>;
export type RunnerHeartbeat = Readonly<{
  idempotencyKey: string;
  principal: VerifiedRunnerPrincipal;
}>;
export type RevokeRunner = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  runnerId: RegisteredRunnerId;
  expectedRunnerEpoch: number;
}>;
export type InspectRunnerEligibility = Readonly<{
  actor: MemberActor;
  runnerId: RegisteredRunnerId;
  projectId: ProjectId;
  mappingRevision: number;
  profileId: SafeProfileId;
  profileVersion: number;
  exposureId?: string;
}>;

export type CommittedRunnerPolicyReplacement = Readonly<{
  runnerId: RegisteredRunnerId;
  expectedPolicyRevision: number;
  audience: RunnerDispatchAudience;
  maximumConcurrentAttempts: number;
}>;
export type RunnerPolicyFacts = Readonly<{
  runnerId: RegisteredRunnerId;
  audience: RunnerDispatchAudience;
  maximumConcurrentAttempts: number;
  policyRevision: number;
}>;

export type ExchangeRunnerCredential = Readonly<{ runnerCredential: string; keyProof: string }>;
export type AuthenticateRunnerAccess = Readonly<{
  accessToken: string;
  proof: string;
  nonce: string;
  method: "GET";
  uri: string;
}>;
