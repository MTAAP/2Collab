import { z } from "zod";
import type { Instant, MemberId, SessionId } from "./ids.ts";
import { IdentifierSchema, InstantSchema, RevisionSchema } from "./ids.ts";

export type TeamRole = "OWNER" | "MEMBER";
export type MemberStatus = "ACTIVE" | "REVOKED";

export type Member = Readonly<{
  id: MemberId;
  displayName: string;
  role: TeamRole;
  status: MemberStatus;
  authorityEpoch: number;
  revision: number;
}>;

export type MemberSession = Readonly<{
  id: SessionId;
  memberId: MemberId;
  expiresAt: Instant;
}>;

export type MemberSessionIssue = MemberSession & Readonly<{ proof: string; csrfProof: string }>;

export type BeginMemberRoleChange = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
}>;

export type ChangeMemberRole = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  memberId: MemberId;
  expectedRevision: number;
  role: TeamRole;
  challengeId: string;
  response: unknown;
}>;

export type MemberRoleChange = Readonly<{
  memberId: MemberId;
  previousRole: TeamRole;
  role: TeamRole;
  revision: number;
  auditId: string;
}>;

export type MemberActor = Readonly<{
  kind: "MEMBER";
  memberId: MemberId;
  sessionId: SessionId;
  sessionProof: string;
}>;

export type RegistrationPrincipal =
  | MemberActor
  | Readonly<{ kind: "BOOTSTRAP"; secret: string }>
  | Readonly<{ kind: "INVITATION"; secret: string }>
  | Readonly<{ kind: "RECOVERY"; sessionId: SessionId; sessionProof: string }>
  | Readonly<{ kind: "HOST_RECOVERY"; sessionId: SessionId; sessionProof: string }>;

export type BootstrapDeployment = Readonly<{
  idempotencyKey: string;
  bootstrapSecret: string;
  displayName: string;
  credentialName: string;
  challengeId: string;
  response: unknown;
}>;

export type BeginPasskeyRegistration = Readonly<{
  idempotencyKey: string;
  principal: RegistrationPrincipal;
  displayName: string;
}>;

export type PasskeyChallenge = Readonly<{
  challengeId: string;
  challenge: string;
  expiresAt: Instant;
  options: Readonly<Record<string, unknown>>;
}>;

export type FinishPasskeyRegistration = Readonly<{
  idempotencyKey: string;
  principal:
    | MemberActor
    | Readonly<{ kind: "RECOVERY"; sessionId: SessionId; sessionProof: string }>
    | Readonly<{ kind: "HOST_RECOVERY"; sessionId: SessionId; sessionProof: string }>;
  challengeId: string;
  credentialName: string;
  response: unknown;
}>;

export type PasskeyCredential = Readonly<{
  id: string;
  memberId: MemberId;
  name: string;
  revision: number;
  state: "ACTIVE" | "REVOKED";
  createdAt: Instant;
  lastUsedAt?: Instant;
  revokedAt?: Instant;
}>;

export type BeginPasskeyAuthentication = Readonly<{
  idempotencyKey: string;
  credentialId?: string;
}>;
export type AuthenticatePasskey = Readonly<{
  idempotencyKey: string;
  challengeId: string;
  response: unknown;
}>;

export type RevokePasskey = Readonly<{
  actor: MemberActor;
  idempotencyKey: string;
  credentialId: string;
  expectedRevision: number;
}>;
export type ListPasskeys = Readonly<{ actor: MemberActor }>;

export type PasskeyRevocation = Readonly<{
  credentialId: string;
  revokedAt: Instant;
  revision: number;
}>;

export type GenerateRecoveryCodes = Readonly<{
  actor: MemberActor;
  idempotencyKey: string;
}>;

export type RecoveryCodeSet = Readonly<{
  generation: number;
  codes: readonly string[];
  createdAt: Instant;
}>;

export type RedeemRecoveryCode = Readonly<{
  idempotencyKey: string;
  memberId: MemberId;
  code: string;
}>;
export type RecoverySession = Readonly<{
  kind: "RECOVERY";
  id: SessionId;
  memberId: MemberId;
  expiresAt: Instant;
}>;
export type RecoverySessionIssue = RecoverySession & Readonly<{ proof: string }>;

export type CreateInvitation = Readonly<{
  actor: MemberActor;
  idempotencyKey: string;
  label?: string;
}>;

export type TeamInvitation = Readonly<{
  id: string;
  deploymentId: string;
  teamId: string;
  inviterId: MemberId;
  inviterDisplayName: string;
  role: "MEMBER";
  label?: string;
  expiresAt: Instant;
  state: "PENDING" | "EXCHANGED" | "ACCEPTED" | "REVOKED" | "EXPIRED";
}>;

export type InvitationIssue = TeamInvitation & Readonly<{ secret: string }>;

export type ExchangeInvitationSecret = Readonly<{ secret: string; idempotencyKey: string }>;
export type InvitationSession = Readonly<{
  invitationId: string;
  secret: string;
  expiresAt: Instant;
  httpOnly: true;
}>;
export type InspectInvitation = Readonly<{ actor: MemberActor; invitationId: string }>;
export type RevokeInvitation = Readonly<{
  actor: MemberActor;
  idempotencyKey: string;
  invitationId: string;
}>;
export type AcceptInvitationWithVerifiedIdentity = Readonly<{
  idempotencyKey: string;
  invitationSessionSecret: string;
  displayName: string;
  credentialName: string;
  challengeId: string;
  response: unknown;
}>;

export const MemberSchema = z
  .object({
    id: IdentifierSchema,
    displayName: z.string().min(1).max(120),
    role: z.enum(["OWNER", "MEMBER"]),
    status: z.enum(["ACTIVE", "REVOKED"]),
    authorityEpoch: z.number().int().nonnegative(),
    revision: RevisionSchema,
  })
  .strict();

export const MemberSessionSchema = z
  .object({ id: IdentifierSchema, memberId: IdentifierSchema, expiresAt: InstantSchema })
  .strict();

export const MemberSessionIssueSchema = MemberSessionSchema.extend({
  proof: z.string().min(32).max(512),
  csrfProof: z.string().min(32).max(512),
}).strict();

const DisplayNameSchema = z.string().trim().min(1).max(120);
const OneTimeSecretSchema = z.string().min(32).max(512);
const IdempotencyKeySchema = IdentifierSchema;
const MemberActorSchema = z
  .object({
    kind: z.literal("MEMBER"),
    memberId: IdentifierSchema,
    sessionId: IdentifierSchema,
    sessionProof: OneTimeSecretSchema,
  })
  .strict();

export const BeginMemberRoleChangeSchema = z
  .object({ idempotencyKey: IdempotencyKeySchema, actor: MemberActorSchema })
  .strict();

export const ChangeMemberRoleSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    actor: MemberActorSchema,
    memberId: IdentifierSchema,
    expectedRevision: RevisionSchema,
    role: z.enum(["OWNER", "MEMBER"]),
    challengeId: IdentifierSchema,
    response: z.unknown(),
  })
  .strict();

export const MemberRoleChangeSchema = z
  .object({
    memberId: IdentifierSchema,
    previousRole: z.enum(["OWNER", "MEMBER"]),
    role: z.enum(["OWNER", "MEMBER"]),
    revision: RevisionSchema,
    auditId: IdentifierSchema,
  })
  .strict();

export const RegistrationPrincipalSchema = z.discriminatedUnion("kind", [
  MemberActorSchema,
  z.object({ kind: z.literal("BOOTSTRAP"), secret: OneTimeSecretSchema }).strict(),
  z.object({ kind: z.literal("INVITATION"), secret: OneTimeSecretSchema }).strict(),
  z
    .object({
      kind: z.literal("RECOVERY"),
      sessionId: IdentifierSchema,
      sessionProof: OneTimeSecretSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("HOST_RECOVERY"),
      sessionId: IdentifierSchema,
      sessionProof: OneTimeSecretSchema,
    })
    .strict(),
]);

export const BootstrapDeploymentSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    bootstrapSecret: OneTimeSecretSchema,
    displayName: DisplayNameSchema,
    credentialName: DisplayNameSchema,
    challengeId: IdentifierSchema,
    response: z.unknown(),
  })
  .strict();

export const BeginPasskeyRegistrationSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    principal: RegistrationPrincipalSchema,
    displayName: DisplayNameSchema,
  })
  .strict();

export const FinishPasskeyRegistrationSchema = z
  .object({
    principal: z.union([
      MemberActorSchema,
      z
        .object({
          kind: z.literal("RECOVERY"),
          sessionId: IdentifierSchema,
          sessionProof: OneTimeSecretSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("HOST_RECOVERY"),
          sessionId: IdentifierSchema,
          sessionProof: OneTimeSecretSchema,
        })
        .strict(),
    ]),
    idempotencyKey: IdempotencyKeySchema,
    challengeId: IdentifierSchema,
    credentialName: DisplayNameSchema,
    response: z.unknown(),
  })
  .strict();

export const PasskeyCredentialSchema = z
  .object({
    id: IdentifierSchema,
    memberId: IdentifierSchema,
    name: DisplayNameSchema,
    revision: RevisionSchema,
    state: z.enum(["ACTIVE", "REVOKED"]),
    createdAt: InstantSchema,
    lastUsedAt: InstantSchema.optional(),
    revokedAt: InstantSchema.optional(),
  })
  .strict();

export const PasskeyCredentialListSchema = z.array(PasskeyCredentialSchema);

export const PasskeyChallengeSchema = z
  .object({
    challengeId: IdentifierSchema,
    challenge: OneTimeSecretSchema,
    expiresAt: InstantSchema,
    options: z.record(z.string(), z.unknown()),
  })
  .strict();

export const BeginPasskeyAuthenticationSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    credentialId: z
      .string()
      .min(1)
      .max(1366)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

export const AuthenticatePasskeySchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    challengeId: IdentifierSchema,
    response: z.unknown(),
  })
  .strict();

export const RevokePasskeySchema = z
  .object({
    actor: MemberActorSchema,
    idempotencyKey: IdempotencyKeySchema,
    credentialId: IdentifierSchema,
    expectedRevision: RevisionSchema,
  })
  .strict();

export const ListPasskeysSchema = z.object({ actor: MemberActorSchema }).strict();

export const PasskeyRevocationSchema = z
  .object({
    credentialId: IdentifierSchema,
    revokedAt: InstantSchema,
    revision: RevisionSchema,
  })
  .strict();

export const GenerateRecoveryCodesSchema = z
  .object({ actor: MemberActorSchema, idempotencyKey: IdempotencyKeySchema })
  .strict();

export const RecoveryCodeSetSchema = z
  .object({
    generation: z.number().int().positive(),
    codes: z.array(OneTimeSecretSchema).min(1).max(32),
    createdAt: InstantSchema,
  })
  .strict();

export const RedeemRecoveryCodeSchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    memberId: IdentifierSchema,
    code: OneTimeSecretSchema,
  })
  .strict();

export const TeamInvitationSchema = z
  .object({
    id: IdentifierSchema,
    deploymentId: IdentifierSchema,
    teamId: IdentifierSchema,
    inviterId: IdentifierSchema,
    inviterDisplayName: DisplayNameSchema,
    role: z.literal("MEMBER"),
    label: DisplayNameSchema.optional(),
    expiresAt: InstantSchema,
    state: z.enum(["PENDING", "EXCHANGED", "ACCEPTED", "REVOKED", "EXPIRED"]),
  })
  .strict();

export const InvitationIssueSchema = TeamInvitationSchema.extend({
  secret: OneTimeSecretSchema,
}).strict();

export const CreateInvitationSchema = z
  .object({
    actor: MemberActorSchema,
    idempotencyKey: IdempotencyKeySchema,
    label: DisplayNameSchema.optional(),
  })
  .strict();

export const ExchangeInvitationSecretSchema = z
  .object({ secret: OneTimeSecretSchema, idempotencyKey: IdempotencyKeySchema })
  .strict();

export const InvitationSessionSchema = z
  .object({
    invitationId: IdentifierSchema,
    secret: OneTimeSecretSchema,
    expiresAt: InstantSchema,
    httpOnly: z.literal(true),
  })
  .strict();

export const RecoverySessionSchema = z
  .object({
    kind: z.literal("RECOVERY"),
    id: IdentifierSchema,
    memberId: IdentifierSchema,
    expiresAt: InstantSchema,
  })
  .strict();

export const RecoverySessionIssueSchema = RecoverySessionSchema.extend({
  proof: OneTimeSecretSchema,
}).strict();

export const InspectInvitationSchema = z
  .object({ actor: MemberActorSchema, invitationId: IdentifierSchema })
  .strict();

export const RevokeInvitationSchema = z
  .object({
    actor: MemberActorSchema,
    idempotencyKey: IdempotencyKeySchema,
    invitationId: IdentifierSchema,
  })
  .strict();

export const AcceptInvitationWithVerifiedIdentitySchema = z
  .object({
    idempotencyKey: IdempotencyKeySchema,
    invitationSessionSecret: OneTimeSecretSchema,
    displayName: DisplayNameSchema,
    credentialName: DisplayNameSchema,
    challengeId: IdentifierSchema,
    response: z.unknown(),
  })
  .strict();
