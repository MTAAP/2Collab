import type { Database } from "bun:sqlite";
import {
  PasskeyCredentialSchema,
  PasskeyRevocationSchema,
  TeamInvitationSchema,
  type AcceptInvitationWithVerifiedIdentity,
  type BeginPasskeyRegistration,
  type MemberActor,
  type MemberSessionIssue,
  type PasskeyCredential,
  type PasskeyRevocation,
  type RegistrationPrincipal,
  type TeamInvitation,
} from "../../../shared/contracts/identity.ts";
import type { DomainError, Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import type { IdentityAuthority } from "./contract.ts";
import { IdentityIdempotency } from "./idempotency.ts";
import { invitationState } from "./invitations.ts";
import {
  simpleWebAuthnPort,
  type RegistrationVerification,
  type WebAuthnPort,
} from "./passkeys.ts";
import { base64Url, constantTimeEqual, hashOneTimeSecret, sha256 } from "./recovery.ts";

const CHALLENGE_LIFETIME = 5 * 60;
const INVITATION_LIFETIME = 48 * 60 * 60;
const INVITATION_SESSION_LIFETIME = 15 * 60;
const RECOVERY_SESSION_LIFETIME = 15 * 60;
const BROWSER_SESSION_LIFETIME = 7 * 24 * 60 * 60;
const RECOVERY_CODE_COUNT = 8;
const PasskeyCredentialReplaySchema = PasskeyCredentialSchema.transform(
  (value) => value as PasskeyCredential,
);
const PasskeyRevocationReplaySchema = PasskeyRevocationSchema.transform(
  (value) => value as PasskeyRevocation,
);
const TeamInvitationReplaySchema = TeamInvitationSchema.transform(
  (value) => value as TeamInvitation,
);

type ChallengeRow = Readonly<{
  id: string;
  purpose: "PASSKEY_REGISTRATION" | "PASSKEY_AUTHENTICATION";
  challenge_hash: Uint8Array;
  member_id: string | null;
  passkey_credential_id: string | null;
  invitation_exchange_session_id: string | null;
  bootstrap_binding_hash: Uint8Array | null;
  revision: number;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
}>;

type CredentialRow = Readonly<{
  id: string;
  member_id: string;
  credential_id: string;
  public_key: Uint8Array;
  opaque_user_id: Uint8Array;
  signature_counter: number;
  backup_eligible: number;
  backup_state: number;
  device_type: "SINGLE_DEVICE" | "MULTI_DEVICE";
  name: string;
  revision: number;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}>;

type InvitationRow = Readonly<{
  id: string;
  inviter_id: string;
  label: string | null;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
  revision: number;
  created_at: number;
  exchange_id: string | null;
  deployment_id: string;
  team_id: string;
  inviter_display_name: string;
}>;

type ExchangeRow = Readonly<{
  id: string;
  invitation_id: string;
  revision: number;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
}>;

export type IdentityAuthorityDependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  randomBytes: (length: number) => Uint8Array;
  webAuthn?: WebAuthnPort;
  bootstrapSecret: string;
  publicOrigin: string;
  rpId: string;
  rpName: string;
  deriveSecret?: typeof hashOneTimeSecret;
  digest?: typeof sha256;
}>;

function error(
  code: string,
  message: string,
  retry: DomainError["retry"] = "NEVER",
): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

function validText(value: string, max = 120): boolean {
  return value.trim().length > 0 && value.length <= max;
}

function validIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function sessionIssue(
  id: string,
  memberId: string,
  expiresAt: number,
  proof: string,
): MemberSessionIssue {
  return {
    id: id as MemberSessionIssue["id"],
    memberId: memberId as MemberSessionIssue["memberId"],
    expiresAt: expiresAt as MemberSessionIssue["expiresAt"],
    proof,
  };
}

function validateConfiguration(dependencies: IdentityAuthorityDependencies): void {
  let url: URL;
  try {
    url = new URL(dependencies.publicOrigin);
  } catch {
    throw new Error("IDENTITY_CONFIGURATION_INVALID");
  }
  const localhost = url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !(localhost && url.protocol === "http:")) ||
    url.origin !== dependencies.publicOrigin ||
    !(
      dependencies.rpId === url.hostname ||
      (!localhost && url.hostname.endsWith(`.${dependencies.rpId}`))
    ) ||
    !validText(dependencies.rpName) ||
    dependencies.bootstrapSecret.length < 32
  ) {
    throw new Error("IDENTITY_CONFIGURATION_INVALID");
  }
}

export function createIdentityAuthority(
  dependencies: IdentityAuthorityDependencies,
): IdentityAuthority {
  validateConfiguration(dependencies);
  const { database, clock, id, randomBytes } = dependencies;
  const webAuthn = dependencies.webAuthn ?? simpleWebAuthnPort;
  const digest = dependencies.digest ?? sha256;
  const deriveSecret = dependencies.deriveSecret ?? hashOneTimeSecret;
  const validBootstrapSecret = async (secret: string): Promise<boolean> => {
    if (secret.length < 32 || secret.length > 512) return false;
    return constantTimeEqual(await digest(secret), await digest(dependencies.bootstrapSecret));
  };

  const audit = (
    kind: string,
    actorKind: string,
    actorId: string,
    subjectId: string | null,
    details: object,
  ) => {
    database
      .query<void, [string, string, string, string, string | null, string, number]>(
        "INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id("audit"), kind, actorKind, actorId, subjectId, JSON.stringify(details), clock());
  };

  const auditFailure = (surface: string, code: string): void => {
    try {
      audit("IDENTITY_ATTEMPT_FAILED", "SYSTEM", "IDENTITY", null, { surface, code });
    } catch {
      // A failed audit sink must not expose the rejected input or replace the stable domain error.
    }
  };
  const idempotency = new IdentityIdempotency(database, digest, clock, () =>
    auditFailure("IDEMPOTENCY_REPLAY", "IDEMPOTENCY_STORAGE_INVALID"),
  );
  const reject = <T>(
    surface: string,
    code: string,
    message: string,
    retry: DomainError["retry"] = "NEVER",
  ): Result<T> => {
    auditFailure(surface, code);
    return error(code, message, retry);
  };
  const auditedTransaction = <TResult extends Result<unknown>>(
    surface: string,
    operation: () => TResult,
  ): TResult => {
    const result = inImmediateTransaction(database, operation);
    if (!result.ok) auditFailure(surface, result.error.code);
    return result;
  };

  const activeMember = (
    actor: MemberActor,
    proofHash: Uint8Array,
  ): Readonly<{
    role: "OWNER" | "MEMBER";
    memberRevision: number;
    sessionRevision: number;
  }> | null => {
    return database
      .query<
        Readonly<{
          role: "OWNER" | "MEMBER";
          memberRevision: number;
          sessionRevision: number;
        }>,
        [string, string, Uint8Array, number]
      >(
        `SELECT members.role, members.revision AS memberRevision,
                sessions.revision AS sessionRevision FROM members
         JOIN sessions ON sessions.member_id = members.id
         WHERE members.id = ? AND sessions.id = ? AND members.status = 'ACTIVE'
           AND sessions.proof_hash = ? AND sessions.kind = 'BROWSER'
           AND sessions.revoked_at IS NULL AND sessions.expires_at > ?`,
      )
      .get(actor.memberId, actor.sessionId, proofHash, clock());
  };

  const memberAuthority = async (
    actor: MemberActor,
  ): Promise<Readonly<{
    proofHash: Uint8Array;
    member: NonNullable<ReturnType<typeof activeMember>>;
  }> | null> => {
    if (
      typeof actor.sessionProof !== "string" ||
      actor.sessionProof.length < 32 ||
      actor.sessionProof.length > 512
    )
      return null;
    const proofHash = await digest(actor.sessionProof);
    const member = activeMember(actor, proofHash);
    return member ? { proofHash, member } : null;
  };

  const requireOwner = async (actor: MemberActor): Promise<Result<Readonly<{ role: "OWNER" }>>> => {
    const authority = await memberAuthority(actor);
    if (authority?.member.role !== "OWNER")
      return error("OWNER_REQUIRED", "Owner authorization is required.");
    return { ok: true, value: { role: "OWNER" } };
  };

  const challenge = (challengeId: string): ChallengeRow | null =>
    database
      .query<ChallengeRow, [string]>("SELECT * FROM webauthn_challenges WHERE id = ?")
      .get(challengeId);

  const challengeStatus = (
    row: ChallengeRow | null,
    purpose: ChallengeRow["purpose"],
  ): Result<ChallengeRow> => {
    if (!row || row.purpose !== purpose)
      return error("CHALLENGE_INVALID", "Passkey challenge is invalid.");
    if (row.consumed_at !== null || row.revoked_at !== null)
      return error("CHALLENGE_USED", "Passkey challenge was already used.");
    if (clock() >= row.expires_at) return error("CHALLENGE_EXPIRED", "Passkey challenge expired.");
    return { ok: true, value: row };
  };

  const expectedChallenge = (stored: Uint8Array) => async (candidate: string) =>
    constantTimeEqual(await digest(candidate), stored);

  const generatedChallenge = (options: Readonly<Record<string, unknown>>): string | null => {
    const value = options.challenge;
    return typeof value === "string" && /^[A-Za-z0-9_-]{32,512}$/.test(value) ? value : null;
  };

  const responseCredentialId = (response: unknown): string | null => {
    if (response === null || typeof response !== "object" || Array.isArray(response)) return null;
    const candidate = response as Record<string, unknown>;
    const value = candidate.id ?? candidate.credentialId;
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,1366}$/.test(value) ? value : null;
  };

  const exchangeBySecret = async (secret: string): Promise<ExchangeRow | null> => {
    if (secret.length < 32 || secret.length > 512) return null;
    const secretHash = await digest(secret);
    return database
      .query<ExchangeRow, [Uint8Array]>(
        "SELECT id, invitation_id, revision, expires_at, consumed_at, revoked_at FROM invitation_exchange_sessions WHERE session_hash = ?",
      )
      .get(secretHash);
  };

  const registrationActorId = async (principal: RegistrationPrincipal): Promise<string | null> => {
    if (principal.kind === "BOOTSTRAP") return "BOOTSTRAP";
    if (principal.kind === "MEMBER") return `MEMBER_${principal.memberId}`;
    if (principal.kind === "RECOVERY") return `RECOVERY_${principal.sessionId}`;
    const exchange = await exchangeBySecret(principal.secret);
    return exchange ? `INVITATION_${exchange.id}` : null;
  };

  const memberForRegistration = async (
    principal: RegistrationPrincipal,
  ): Promise<
    Result<
      Readonly<{
        memberId: string | null;
        invitationSessionId: string | null;
        bootstrapHash: Uint8Array | null;
        opaqueUserId: Uint8Array;
        sessionRevision: number | null;
        memberRevision: number | null;
        invitationRevision: number | null;
        sessionId: string | null;
        sessionKind: "BROWSER" | "RECOVERY" | null;
        sessionProofHash: Uint8Array | null;
      }>
    >
  > => {
    if (principal.kind === "BOOTSTRAP") {
      if (!(await validBootstrapSecret(principal.secret)))
        return error("BOOTSTRAP_SECRET_INVALID", "Bootstrap secret is invalid.");
      if (
        database.query<{ count: number }, []>("SELECT count(*) AS count FROM deployments").get()
          ?.count
      )
        return error("DEPLOYMENT_ALREADY_BOOTSTRAPPED", "Deployment was already bootstrapped.");
      const binding = await digest(principal.secret);
      return {
        ok: true,
        value: {
          memberId: null,
          invitationSessionId: null,
          bootstrapHash: binding,
          opaqueUserId: (await digest(`bootstrap:${principal.secret}`)).slice(0, 32),
          sessionRevision: null,
          memberRevision: null,
          invitationRevision: null,
          sessionId: null,
          sessionKind: null,
          sessionProofHash: null,
        },
      };
    }
    if (principal.kind === "INVITATION") {
      const exchange = await exchangeBySecret(principal.secret);
      const invitation = exchange ? getInvitation(exchange.invitation_id) : null;
      if (
        !exchange ||
        exchange.consumed_at !== null ||
        exchange.revoked_at !== null ||
        clock() >= exchange.expires_at ||
        !invitation ||
        invitation.consumed_at !== null ||
        invitation.revoked_at !== null ||
        clock() >= invitation.expires_at
      ) {
        return error("INVITATION_SESSION_INVALID", "Invitation session is invalid.");
      }
      return {
        ok: true,
        value: {
          memberId: null,
          invitationSessionId: exchange.id,
          bootstrapHash: null,
          opaqueUserId: (await digest(`invitation:${exchange.id}`)).slice(0, 32),
          sessionRevision: exchange.revision,
          memberRevision: null,
          invitationRevision: invitation.revision,
          sessionId: exchange.id,
          sessionKind: null,
          sessionProofHash: null,
        },
      };
    }
    if (principal.kind === "RECOVERY") {
      if (
        typeof principal.sessionProof !== "string" ||
        principal.sessionProof.length < 32 ||
        principal.sessionProof.length > 512
      )
        return error("RECOVERY_SESSION_INVALID", "Recovery session is invalid.");
      const proofHash = await digest(principal.sessionProof);
      const row = database
        .query<
          Readonly<{ member_id: string; session_revision: number; member_revision: number }>,
          [string, Uint8Array, number]
        >(
          `SELECT sessions.member_id, sessions.revision AS session_revision,
                  members.revision AS member_revision
           FROM sessions JOIN members ON members.id = sessions.member_id
           WHERE sessions.id = ? AND sessions.proof_hash = ? AND sessions.kind = 'RECOVERY'
             AND sessions.revoked_at IS NULL
             AND sessions.expires_at > ? AND members.status = 'ACTIVE'`,
        )
        .get(principal.sessionId, proofHash, clock());
      if (!row) return error("RECOVERY_SESSION_INVALID", "Recovery session is invalid.");
      const existing = database
        .query<Readonly<{ opaque_user_id: Uint8Array }>, [string]>(
          "SELECT opaque_user_id FROM passkey_credentials WHERE member_id = ? ORDER BY created_at LIMIT 1",
        )
        .get(row.member_id);
      return {
        ok: true,
        value: {
          memberId: row.member_id,
          invitationSessionId: null,
          bootstrapHash: null,
          opaqueUserId:
            existing?.opaque_user_id ?? (await digest(`member:${row.member_id}`)).slice(0, 32),
          sessionRevision: row.session_revision,
          memberRevision: row.member_revision,
          invitationRevision: null,
          sessionId: principal.sessionId,
          sessionKind: "RECOVERY",
          sessionProofHash: proofHash,
        },
      };
    }
    const resolvedAuthority = await memberAuthority(principal);
    if (!resolvedAuthority) return error("SESSION_INVALID", "Member session is invalid.");
    const existing = database
      .query<Readonly<{ opaque_user_id: Uint8Array }>, [string]>(
        "SELECT opaque_user_id FROM passkey_credentials WHERE member_id = ? ORDER BY created_at LIMIT 1",
      )
      .get(principal.memberId);
    return {
      ok: true,
      value: {
        memberId: principal.memberId,
        invitationSessionId: null,
        bootstrapHash: null,
        opaqueUserId:
          existing?.opaque_user_id ?? (await digest(`member:${principal.memberId}`)).slice(0, 32),
        sessionRevision: resolvedAuthority.member.sessionRevision,
        memberRevision: resolvedAuthority.member.memberRevision,
        invitationRevision: null,
        sessionId: principal.sessionId,
        sessionKind: "BROWSER",
        sessionProofHash: resolvedAuthority.proofHash,
      },
    };
  };

  type RegistrationAuthority = Extract<
    Awaited<ReturnType<typeof memberForRegistration>>,
    { ok: true }
  >["value"];

  const registrationAuthorityCurrent = (authority: RegistrationAuthority): boolean => {
    if (authority.bootstrapHash) {
      return (
        database.query<{ count: number }, []>("SELECT count(*) AS count FROM deployments").get()
          ?.count === 0
      );
    }
    if (authority.invitationSessionId) {
      return Boolean(
        database
          .query<{ id: string }, [string, number, number, number, number]>(
            `SELECT invitation_exchange_sessions.id
             FROM invitation_exchange_sessions
             JOIN invitations ON invitations.id = invitation_exchange_sessions.invitation_id
             WHERE invitation_exchange_sessions.id = ?
               AND invitation_exchange_sessions.revision = ?
               AND invitations.revision = ?
               AND invitation_exchange_sessions.consumed_at IS NULL
               AND invitation_exchange_sessions.revoked_at IS NULL
               AND invitation_exchange_sessions.expires_at > ?
               AND invitations.consumed_at IS NULL AND invitations.revoked_at IS NULL
               AND invitations.expires_at > ?`,
          )
          .get(
            authority.invitationSessionId,
            authority.sessionRevision ?? -1,
            authority.invitationRevision ?? -1,
            clock(),
            clock(),
          ),
      );
    }
    if (!authority.memberId) return false;
    return Boolean(
      database
        .query<{ id: string }, [string, string, string, Uint8Array, number, number, number]>(
          `SELECT sessions.id FROM sessions JOIN members ON members.id = sessions.member_id
           WHERE sessions.member_id = ? AND sessions.id = ? AND sessions.kind = ?
             AND sessions.proof_hash = ?
             AND sessions.revision = ? AND members.revision = ?
             AND members.status = 'ACTIVE' AND sessions.revoked_at IS NULL
             AND sessions.expires_at > ?`,
        )
        .get(
          authority.memberId,
          authority.sessionId ?? "",
          authority.sessionKind ?? "",
          authority.sessionProofHash ?? new Uint8Array(),
          authority.sessionRevision ?? -1,
          authority.memberRevision ?? -1,
          clock(),
        ),
    );
  };

  const insertCredential = (
    memberId: string,
    opaqueUserId: Uint8Array,
    name: string,
    verified: Extract<RegistrationVerification, { verified: true }>,
  ): PasskeyCredential => {
    const credentialId = id("passkey");
    const now = clock();
    database
      .query<
        void,
        [
          string,
          string,
          string,
          Uint8Array,
          Uint8Array,
          number,
          number,
          number,
          string,
          string,
          number,
        ]
      >(
        `INSERT INTO passkey_credentials(id, member_id, credential_id, public_key, opaque_user_id,
         signature_counter, backup_eligible, backup_state, device_type, name, revision, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        credentialId,
        memberId,
        verified.credential.credentialId,
        verified.credential.publicKey,
        opaqueUserId,
        verified.credential.counter,
        verified.credential.deviceType === "MULTI_DEVICE" ? 1 : 0,
        verified.credential.backedUp ? 1 : 0,
        verified.credential.deviceType,
        name,
        now,
      );
    const addTransport = database.query<void, [string, string]>(
      "INSERT INTO passkey_credential_transports(passkey_credential_id, transport) VALUES (?, ?)",
    );
    for (const transport of new Set(verified.credential.transports))
      addTransport.run(credentialId, transport);
    return {
      id: credentialId,
      memberId: memberId as PasskeyCredential["memberId"],
      name,
      revision: 1,
      state: "ACTIVE",
      createdAt: now as PasskeyCredential["createdAt"],
    };
  };

  const verifyRegistration = async (
    row: ChallengeRow,
    response: unknown,
  ): Promise<Result<Extract<RegistrationVerification, { verified: true }>>> => {
    try {
      const verified = await webAuthn.verifyRegistration({
        response,
        expectedChallenge: expectedChallenge(row.challenge_hash),
        expectedOrigin: dependencies.publicOrigin,
        expectedRpId: dependencies.rpId,
      });
      if (!verified.verified)
        return error("PASSKEY_VERIFICATION_FAILED", "Passkey verification failed.");
      return { ok: true, value: verified };
    } catch {
      return error("PASSKEY_VERIFICATION_FAILED", "Passkey verification failed.");
    }
  };

  const invitationView = (row: InvitationRow): TeamInvitation => ({
    id: row.id,
    deploymentId: row.deployment_id,
    teamId: row.team_id,
    inviterId: row.inviter_id as TeamInvitation["inviterId"],
    inviterDisplayName: row.inviter_display_name,
    role: "MEMBER",
    ...(row.label ? { label: row.label } : {}),
    expiresAt: row.expires_at as TeamInvitation["expiresAt"],
    state: invitationState(row, clock()),
  });

  const getInvitation = (invitationId: string): InvitationRow | null =>
    database
      .query<InvitationRow, [string]>(
        `SELECT invitations.*, invitation_exchange_sessions.id AS exchange_id,
                deployments.id AS deployment_id, deployments.team_id AS team_id,
                members.display_name AS inviter_display_name
         FROM invitations LEFT JOIN invitation_exchange_sessions
           ON invitation_exchange_sessions.invitation_id = invitations.id
         JOIN members ON members.id = invitations.inviter_id
         CROSS JOIN deployments
         WHERE invitations.id = ?`,
      )
      .get(invitationId);

  return {
    async beginPasskeyRegistration(command: BeginPasskeyRegistration) {
      if (!validText(command.displayName) || !validIdempotencyKey(command.idempotencyKey))
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const actorId = await registrationActorId(command.principal);
      if (actorId) {
        const earlyTicket = await idempotency.ticket(
          "PASSKEY_REGISTRATION_BEGIN",
          actorId,
          command.idempotencyKey,
          command,
        );
        if (!earlyTicket.ok) return earlyTicket;
        const earlyReplay = idempotency.replay<never>(earlyTicket.value);
        if (earlyReplay) return earlyReplay;
      }
      const principal = await memberForRegistration(command.principal);
      if (!principal.ok) {
        auditFailure("PASSKEY_REGISTRATION_BEGIN", principal.error.code);
        return principal;
      }
      const ticket = await idempotency.ticket(
        "PASSKEY_REGISTRATION_BEGIN",
        actorId ?? `MEMBER_${principal.value.memberId}`,
        command.idempotencyKey,
        command,
      );
      if (!ticket.ok) return ticket;
      const replay = idempotency.replay<never>(ticket.value);
      if (replay) return replay;
      const challengeId = id("challenge");
      const now = clock();
      try {
        const excludes = principal.value.memberId
          ? database
              .query<Readonly<{ credential_id: string; transports: string | null }>, [string]>(
                `SELECT passkey_credentials.credential_id, group_concat(passkey_credential_transports.transport) AS transports
                 FROM passkey_credentials LEFT JOIN passkey_credential_transports ON passkey_credential_transports.passkey_credential_id = passkey_credentials.id
                 WHERE passkey_credentials.member_id = ? AND passkey_credentials.revoked_at IS NULL GROUP BY passkey_credentials.id`,
              )
              .all(principal.value.memberId)
              .map((row) => ({
                id: row.credential_id,
                transports: row.transports?.split(",") ?? [],
              }))
          : [];
        const options = await webAuthn.generateRegistrationOptions({
          challenge: randomBytes(32),
          rpName: dependencies.rpName,
          rpId: dependencies.rpId,
          userId: principal.value.opaqueUserId,
          userName: principal.value.memberId ?? "new-member",
          userDisplayName: command.displayName,
          excludeCredentials: excludes,
        });
        const rawChallenge = generatedChallenge(options);
        if (!rawChallenge) return error("PASSKEY_OPERATION_FAILED", "Passkey operation failed.");
        const hash = await digest(rawChallenge);
        return auditedTransaction("PASSKEY_REGISTRATION_BEGIN", () => {
          const committedReplay = idempotency.replay<never>(ticket.value);
          if (committedReplay) return committedReplay;
          if (!registrationAuthorityCurrent(principal.value)) {
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          }
          database
            .query<
              void,
              [
                string,
                Uint8Array,
                string | null,
                string | null,
                Uint8Array | null,
                string,
                string,
                number,
                number,
              ]
            >(
              `INSERT INTO webauthn_challenges(id, purpose, challenge_hash, member_id,
               invitation_exchange_session_id, bootstrap_binding_hash, rp_id, expected_origin,
               revision, created_at, expires_at) VALUES (?, 'PASSKEY_REGISTRATION', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              challengeId,
              hash,
              principal.value.memberId,
              principal.value.invitationSessionId,
              principal.value.bootstrapHash,
              dependencies.rpId,
              dependencies.publicOrigin,
              now,
              now + CHALLENGE_LIFETIME,
            );
          idempotency.storeSecretIssued(
            ticket.value,
            "SECRET_ALREADY_ISSUED",
            "Passkey challenge was already issued.",
          );
          return {
            ok: true,
            value: {
              challengeId,
              challenge: rawChallenge,
              expiresAt: (now + CHALLENGE_LIFETIME) as never,
              options,
            },
          } as const;
        });
      } catch {
        auditFailure("PASSKEY_REGISTRATION_BEGIN", "PASSKEY_OPERATION_FAILED");
        return error("PASSKEY_OPERATION_FAILED", "Passkey operation failed.");
      }
    },

    async bootstrap(command) {
      if (
        !validIdempotencyKey(command.idempotencyKey) ||
        !(await validBootstrapSecret(command.bootstrapSecret)) ||
        !validText(command.displayName) ||
        !validText(command.credentialName)
      ) {
        auditFailure("BOOTSTRAP", "BOOTSTRAP_SECRET_INVALID");
        return error("BOOTSTRAP_SECRET_INVALID", "Bootstrap secret is invalid.");
      }
      const ticket = await idempotency.ticket(
        "BOOTSTRAP_FINISH",
        "BOOTSTRAP",
        command.idempotencyKey,
        command,
      );
      if (!ticket.ok) {
        auditFailure("BOOTSTRAP", ticket.error.code);
        return ticket;
      }
      const replay = idempotency.replay<never>(ticket.value);
      if (replay) return replay;
      const status = challengeStatus(challenge(command.challengeId), "PASSKEY_REGISTRATION");
      if (!status.ok) {
        auditFailure("BOOTSTRAP", status.error.code);
        return status;
      }
      const binding = await digest(command.bootstrapSecret);
      if (
        !status.value.bootstrap_binding_hash ||
        !constantTimeEqual(binding, status.value.bootstrap_binding_hash)
      ) {
        auditFailure("BOOTSTRAP", "CHALLENGE_INVALID");
        return error("CHALLENGE_INVALID", "Passkey challenge is invalid.");
      }
      const verified = await verifyRegistration(status.value, command.response);
      if (!verified.ok) {
        auditFailure("BOOTSTRAP", verified.error.code);
        return verified;
      }
      const opaqueUserId = (await digest(`bootstrap:${command.bootstrapSecret}`)).slice(0, 32);
      const sessionProof = base64Url(randomBytes(32));
      const sessionProofHash = await digest(sessionProof);
      try {
        return auditedTransaction("BOOTSTRAP", () => {
          const committedReplay = idempotency.replay<never>(ticket.value);
          if (committedReplay) return committedReplay;
          if (
            database.query<{ count: number }, []>("SELECT count(*) AS count FROM deployments").get()
              ?.count
          )
            return error("DEPLOYMENT_ALREADY_BOOTSTRAPPED", "Deployment was already bootstrapped.");
          const current = challengeStatus(challenge(command.challengeId), "PASSKEY_REGISTRATION");
          if (!current.ok) return current;
          if (current.value.revision !== status.value.revision)
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          const now = clock();
          const deploymentId = id("deployment");
          const teamId = id("team");
          const memberId = id("member");
          const sessionId = id("session");
          database
            .query<void, [string, string, number]>(
              "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES (?, 1, ?, 1, ?)",
            )
            .run(deploymentId, teamId, now);
          database
            .query<void, [string, string, number]>(
              "INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at) VALUES (?, ?, 'OWNER', 'ACTIVE', 1, 1, ?)",
            )
            .run(memberId, command.displayName.trim(), now);
          insertCredential(memberId, opaqueUserId, command.credentialName.trim(), verified.value);
          database
            .query<void, [string, string, Uint8Array, number]>(
              "INSERT INTO sessions(id, member_id, proof_hash, kind, expires_at, revision) VALUES (?, ?, ?, 'BROWSER', ?, 1)",
            )
            .run(sessionId, memberId, sessionProofHash, now + BROWSER_SESSION_LIFETIME);
          database
            .query<void, [number, string]>(
              "UPDATE webauthn_challenges SET consumed_at = ?, revision = revision + 1 WHERE id = ? AND consumed_at IS NULL",
            )
            .run(now, command.challengeId);
          audit("DEPLOYMENT_BOOTSTRAPPED", "BOOTSTRAP", deploymentId, memberId, { role: "OWNER" });
          const result = {
            ok: true,
            value: sessionIssue(sessionId, memberId, now + BROWSER_SESSION_LIFETIME, sessionProof),
          } as const;
          idempotency.storeSecretIssued(
            ticket.value,
            "SECRET_ALREADY_ISSUED",
            "Browser session proof was already issued.",
          );
          return result;
        });
      } catch {
        auditFailure("BOOTSTRAP", "IDENTITY_OPERATION_FAILED");
        return error("IDENTITY_OPERATION_FAILED", "Identity operation failed.");
      }
    },

    async finishPasskeyRegistration(command) {
      if (!validText(command.credentialName) || !validIdempotencyKey(command.idempotencyKey))
        return reject(
          "PASSKEY_REGISTRATION_FINISH",
          "IDENTITY_INPUT_INVALID",
          "Identity input is invalid.",
        );
      const ticket = await idempotency.ticket(
        "PASSKEY_REGISTRATION_FINISH",
        command.principal.kind === "RECOVERY"
          ? `RECOVERY_${command.principal.sessionId}`
          : `MEMBER_${command.principal.memberId}`,
        command.idempotencyKey,
        command,
      );
      if (!ticket.ok) {
        auditFailure("PASSKEY_REGISTRATION_FINISH", ticket.error.code);
        return ticket;
      }
      const replay = idempotency.replay(ticket.value, PasskeyCredentialReplaySchema);
      if (replay) return replay;
      const principal = await memberForRegistration(command.principal);
      if (!principal.ok || !principal.value.memberId)
        return principal.ok ? error("SESSION_INVALID", "Member session is invalid.") : principal;
      const status = challengeStatus(challenge(command.challengeId), "PASSKEY_REGISTRATION");
      if (!status.ok) return status;
      if (status.value.member_id !== principal.value.memberId)
        return error("CHALLENGE_INVALID", "Passkey challenge is invalid.");
      const verified = await verifyRegistration(status.value, command.response);
      if (!verified.ok) {
        auditFailure("PASSKEY_REGISTRATION_FINISH", verified.error.code);
        return verified;
      }
      try {
        return auditedTransaction("PASSKEY_REGISTRATION_FINISH", () => {
          const committedReplay = idempotency.replay(ticket.value, PasskeyCredentialReplaySchema);
          if (committedReplay) return committedReplay;
          if (!registrationAuthorityCurrent(principal.value))
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          const current = challengeStatus(challenge(command.challengeId), "PASSKEY_REGISTRATION");
          if (!current.ok) return current;
          if (current.value.revision !== status.value.revision)
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          const credential = insertCredential(
            principal.value.memberId as string,
            principal.value.opaqueUserId,
            command.credentialName.trim(),
            verified.value,
          );
          database
            .query<void, [number, string]>(
              "UPDATE webauthn_challenges SET consumed_at = ?, revision = revision + 1 WHERE id = ?",
            )
            .run(clock(), command.challengeId);
          if (command.principal.kind === "RECOVERY")
            database
              .query<void, [number, string]>(
                "UPDATE sessions SET revoked_at = ?, revision = revision + 1 WHERE id = ?",
              )
              .run(clock(), command.principal.sessionId);
          audit(
            "PASSKEY_REGISTERED",
            command.principal.kind,
            principal.value.memberId as string,
            credential.id,
            { recovery: command.principal.kind === "RECOVERY" },
          );
          const result = { ok: true, value: credential } as const;
          idempotency.storeResult(ticket.value, result);
          return result;
        });
      } catch {
        auditFailure("PASSKEY_REGISTRATION_FINISH", "IDENTITY_OPERATION_FAILED");
        return error("IDENTITY_OPERATION_FAILED", "Identity operation failed.");
      }
    },

    async beginPasskeyAuthentication(command) {
      if (!validIdempotencyKey(command.idempotencyKey))
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const ticket = await idempotency.ticket(
        "PASSKEY_AUTHENTICATION_BEGIN",
        "PASSKEY_AUTHENTICATION_BEGIN",
        command.idempotencyKey,
        command,
      );
      if (!ticket.ok) return ticket;
      const replay = idempotency.replay<never>(ticket.value);
      if (replay) return replay;
      const credential = command.credentialId
        ? database
            .query<CredentialRow, [string]>(
              "SELECT * FROM passkey_credentials WHERE credential_id = ? AND revoked_at IS NULL",
            )
            .get(command.credentialId)
        : null;
      if (command.credentialId && !credential)
        return error("PASSKEY_NOT_FOUND", "Passkey was not found.");
      const credentialMemberRevision = credential
        ? database
            .query<{ revision: number }, [string]>(
              "SELECT revision FROM members WHERE id = ? AND status = 'ACTIVE'",
            )
            .get(credential.member_id)?.revision
        : undefined;
      if (credential && credentialMemberRevision === undefined)
        return error("PASSKEY_NOT_FOUND", "Passkey was not found.");
      const challengeId = id("challenge");
      const now = clock();
      try {
        const allowCredentials = credential
          ? [
              {
                id: credential.credential_id,
                transports: database
                  .query<{ transport: string }, [string]>(
                    "SELECT transport FROM passkey_credential_transports WHERE passkey_credential_id = ?",
                  )
                  .all(credential.id)
                  .map((row) => row.transport),
              },
            ]
          : undefined;
        const options = await webAuthn.generateAuthenticationOptions({
          challenge: randomBytes(32),
          rpId: dependencies.rpId,
          ...(allowCredentials ? { allowCredentials } : {}),
        });
        const rawChallenge = generatedChallenge(options);
        if (!rawChallenge) return error("PASSKEY_OPERATION_FAILED", "Passkey operation failed.");
        const hash = await digest(rawChallenge);
        return auditedTransaction("PASSKEY_AUTHENTICATION_BEGIN", () => {
          const committedReplay = idempotency.replay<never>(ticket.value);
          if (committedReplay) return committedReplay;
          if (credential) {
            const current = database
              .query<{ id: string }, [string, string, number, number]>(
                `SELECT passkey_credentials.id FROM passkey_credentials
                 JOIN members ON members.id = passkey_credentials.member_id
                 WHERE passkey_credentials.id = ? AND passkey_credentials.member_id = ?
                   AND passkey_credentials.revision = ? AND passkey_credentials.revoked_at IS NULL
                   AND members.status = 'ACTIVE' AND members.revision = ?`,
              )
              .get(
                credential.id,
                credential.member_id,
                credential.revision,
                credentialMemberRevision ?? -1,
              );
            if (!current)
              return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          }
          database
            .query<
              void,
              [string, Uint8Array, string | null, string | null, string, string, number, number]
            >(
              `INSERT INTO webauthn_challenges(id, purpose, challenge_hash, member_id,
               passkey_credential_id, rp_id, expected_origin, revision, created_at, expires_at)
               VALUES (?, 'PASSKEY_AUTHENTICATION', ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              challengeId,
              hash,
              credential?.member_id ?? null,
              credential?.id ?? null,
              dependencies.rpId,
              dependencies.publicOrigin,
              now,
              now + CHALLENGE_LIFETIME,
            );
          idempotency.storeSecretIssued(
            ticket.value,
            "SECRET_ALREADY_ISSUED",
            "Passkey challenge was already issued.",
          );
          return {
            ok: true,
            value: {
              challengeId,
              challenge: rawChallenge,
              expiresAt: (now + CHALLENGE_LIFETIME) as never,
              options,
            },
          };
        });
      } catch {
        auditFailure("PASSKEY_AUTHENTICATION_BEGIN", "PASSKEY_OPERATION_FAILED");
        return error("PASSKEY_OPERATION_FAILED", "Passkey operation failed.");
      }
    },

    async authenticate(command) {
      if (!validIdempotencyKey(command.idempotencyKey))
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const ticket = await idempotency.ticket(
        "PASSKEY_AUTHENTICATION_FINISH",
        `AUTH_CHALLENGE_${command.challengeId}`,
        command.idempotencyKey,
        command,
      );
      if (!ticket.ok) {
        auditFailure("PASSKEY_AUTHENTICATION", ticket.error.code);
        return ticket;
      }
      const replay = idempotency.replay<never>(ticket.value);
      if (replay) return replay;
      const status = challengeStatus(challenge(command.challengeId), "PASSKEY_AUTHENTICATION");
      if (!status.ok) {
        auditFailure("PASSKEY_AUTHENTICATION", status.error.code);
        return status;
      }
      const publicId = responseCredentialId(command.response);
      if (!publicId) {
        auditFailure("PASSKEY_AUTHENTICATION", "PASSKEY_VERIFICATION_FAILED");
        return error("PASSKEY_VERIFICATION_FAILED", "Passkey verification failed.");
      }
      const credential = database
        .query<CredentialRow, [string]>(
          "SELECT * FROM passkey_credentials WHERE credential_id = ? AND revoked_at IS NULL",
        )
        .get(publicId);
      if (
        !credential ||
        (status.value.passkey_credential_id !== null &&
          status.value.passkey_credential_id !== credential.id) ||
        (status.value.member_id !== null && status.value.member_id !== credential.member_id)
      ) {
        auditFailure("PASSKEY_AUTHENTICATION", "PASSKEY_VERIFICATION_FAILED");
        return error("PASSKEY_VERIFICATION_FAILED", "Passkey verification failed.");
      }
      const memberSnapshot = database
        .query<{ revision: number }, [string]>(
          "SELECT revision FROM members WHERE id = ? AND status = 'ACTIVE'",
        )
        .get(credential.member_id);
      if (!memberSnapshot) {
        auditFailure("PASSKEY_AUTHENTICATION", "MEMBER_REVOKED");
        return error("MEMBER_REVOKED", "Member is not active.");
      }
      const transports = database
        .query<{ transport: string }, [string]>(
          "SELECT transport FROM passkey_credential_transports WHERE passkey_credential_id = ?",
        )
        .all(credential.id)
        .map((row) => row.transport);
      try {
        const verified = await webAuthn.verifyAuthentication({
          response: command.response,
          expectedChallenge: expectedChallenge(status.value.challenge_hash),
          expectedOrigin: dependencies.publicOrigin,
          expectedRpId: dependencies.rpId,
          credential: {
            id: credential.credential_id,
            publicKey: credential.public_key,
            counter: credential.signature_counter,
            transports,
          },
        });
        if (!verified.verified) {
          auditFailure("PASSKEY_AUTHENTICATION", "PASSKEY_VERIFICATION_FAILED");
          return error("PASSKEY_VERIFICATION_FAILED", "Passkey verification failed.");
        }
        const sessionProof = base64Url(randomBytes(32));
        const sessionProofHash = await digest(sessionProof);
        return auditedTransaction("PASSKEY_AUTHENTICATION", () => {
          const committedReplay = idempotency.replay<never>(ticket.value);
          if (committedReplay) return committedReplay;
          const current = challengeStatus(challenge(command.challengeId), "PASSKEY_AUTHENTICATION");
          if (!current.ok) return current;
          if (current.value.revision !== status.value.revision)
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          if (
            (current.value.passkey_credential_id !== null &&
              current.value.passkey_credential_id !== credential.id) ||
            (current.value.member_id !== null && current.value.member_id !== credential.member_id)
          )
            return error("CHALLENGE_INVALID", "Passkey challenge is invalid.");
          const active = database
            .query<{ id: string }, [string, number]>(
              "SELECT id FROM members WHERE id = ? AND status = 'ACTIVE' AND revision = ?",
            )
            .get(credential.member_id, memberSnapshot.revision);
          if (!active) return error("MEMBER_REVOKED", "Member is not active.");
          const now = clock();
          const update = database
            .query<void, [number, number, number, string, number, string, number]>(
              "UPDATE passkey_credentials SET signature_counter = ?, backup_eligible = ?, backup_state = ?, device_type = ?, last_used_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND revoked_at IS NULL",
            )
            .run(
              verified.newCounter,
              verified.deviceType === "MULTI_DEVICE" ? 1 : 0,
              verified.backedUp ? 1 : 0,
              verified.deviceType,
              now,
              credential.id,
              credential.revision,
            );
          if (update.changes !== 1)
            return error(
              "CREDENTIAL_STALE",
              "Passkey state changed. Retry authentication.",
              "SAME_INPUT",
            );
          const sessionId = id("session");
          database
            .query<void, [string, string, Uint8Array, number]>(
              "INSERT INTO sessions(id, member_id, proof_hash, kind, expires_at, revision) VALUES (?, ?, ?, 'BROWSER', ?, 1)",
            )
            .run(sessionId, credential.member_id, sessionProofHash, now + BROWSER_SESSION_LIFETIME);
          database
            .query<void, [number, string]>(
              "UPDATE webauthn_challenges SET consumed_at = ?, revision = revision + 1 WHERE id = ?",
            )
            .run(now, command.challengeId);
          audit("PASSKEY_AUTHENTICATED", "PASSKEY", credential.member_id, credential.id, {
            counterUpdated: true,
          });
          const result = {
            ok: true,
            value: sessionIssue(
              sessionId,
              credential.member_id,
              now + BROWSER_SESSION_LIFETIME,
              sessionProof,
            ),
          } as const;
          idempotency.storeSecretIssued(
            ticket.value,
            "SECRET_ALREADY_ISSUED",
            "Browser session proof was already issued.",
          );
          return result;
        });
      } catch {
        auditFailure("PASSKEY_AUTHENTICATION", "PASSKEY_VERIFICATION_FAILED");
        return error("PASSKEY_VERIFICATION_FAILED", "Passkey verification failed.");
      }
    },

    async revokePasskey(command) {
      if (!validIdempotencyKey(command.idempotencyKey))
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const ticket = await idempotency.ticket(
        "PASSKEY_REVOKE",
        `MEMBER_${command.actor.memberId}`,
        command.idempotencyKey,
        command,
      );
      if (!ticket.ok) return ticket;
      const replay = idempotency.replay(ticket.value, PasskeyRevocationReplaySchema);
      if (replay) return replay;
      const resolvedAuthority = await memberAuthority(command.actor);
      const authority = resolvedAuthority?.member;
      if (!authority) return error("SESSION_INVALID", "Member session is invalid.");
      try {
        return auditedTransaction("PASSKEY_REVOKE", () => {
          const committedReplay = idempotency.replay(ticket.value, PasskeyRevocationReplaySchema);
          if (committedReplay) return committedReplay;
          const currentAuthority = activeMember(command.actor, resolvedAuthority.proofHash);
          if (
            !currentAuthority ||
            currentAuthority.memberRevision !== authority.memberRevision ||
            currentAuthority.sessionRevision !== authority.sessionRevision
          )
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          const now = clock();
          const update = database
            .query<void, [number, string, string, number]>(
              "UPDATE passkey_credentials SET revoked_at = ?, revision = revision + 1 WHERE id = ? AND member_id = ? AND revision = ? AND revoked_at IS NULL",
            )
            .run(now, command.credentialId, command.actor.memberId, command.expectedRevision);
          if (update.changes !== 1) return error("PASSKEY_STALE", "Passkey state changed.");
          audit("PASSKEY_REVOKED", "MEMBER", command.actor.memberId, command.credentialId, {});
          const result = {
            ok: true,
            value: {
              credentialId: command.credentialId,
              revokedAt: now as never,
              revision: command.expectedRevision + 1,
            },
          } as const;
          idempotency.storeResult(ticket.value, result);
          return result;
        });
      } catch {
        auditFailure("PASSKEY_REVOKE", "IDENTITY_OPERATION_FAILED");
        return error("IDENTITY_OPERATION_FAILED", "Identity operation failed.");
      }
    },

    async listPasskeys(query) {
      if (!(await memberAuthority(query.actor)))
        return error("SESSION_INVALID", "Member session is invalid.");
      const rows = database
        .query<CredentialRow, [string]>(
          "SELECT * FROM passkey_credentials WHERE member_id = ? ORDER BY created_at, id",
        )
        .all(query.actor.memberId);
      return {
        ok: true,
        value: rows.map((row) => ({
          id: row.id,
          memberId: row.member_id as PasskeyCredential["memberId"],
          name: row.name,
          revision: row.revision,
          createdAt: row.created_at as PasskeyCredential["createdAt"],
          ...(row.last_used_at === null
            ? {}
            : { lastUsedAt: row.last_used_at as PasskeyCredential["lastUsedAt"] }),
          ...(row.revoked_at === null
            ? {}
            : { revokedAt: row.revoked_at as PasskeyCredential["revokedAt"] }),
          state: row.revoked_at === null ? "ACTIVE" : "REVOKED",
        })),
      };
    },

    async invite(command) {
      if (!validIdempotencyKey(command.idempotencyKey))
        return reject("INVITATION_CREATE", "IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      if (command.label !== undefined && !validText(command.label))
        return reject("INVITATION_CREATE", "IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const ticket = await idempotency.ticket(
        "INVITATION_CREATE",
        `MEMBER_${command.actor.memberId}`,
        command.idempotencyKey,
        command,
      );
      if (!ticket.ok) return ticket;
      const replay = idempotency.replay<never>(ticket.value);
      if (replay) return replay;
      const resolvedAuthority = await memberAuthority(command.actor);
      const authority = resolvedAuthority?.member;
      if (!resolvedAuthority || authority?.role !== "OWNER")
        return reject("INVITATION_CREATE", "OWNER_REQUIRED", "Owner authorization is required.");
      const authorityProofHash = resolvedAuthority.proofHash;
      const rawSecret = base64Url(randomBytes(32));
      const tokenHash = await digest(rawSecret);
      const now = clock();
      try {
        return auditedTransaction("INVITATION_CREATE", () => {
          const committedReplay = idempotency.replay<never>(ticket.value);
          if (committedReplay) return committedReplay;
          const currentAuthority = activeMember(command.actor, authorityProofHash);
          if (
            currentAuthority?.role !== "OWNER" ||
            currentAuthority.memberRevision !== authority.memberRevision ||
            currentAuthority.sessionRevision !== authority.sessionRevision
          )
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          const invitationId = id("invitation");
          const deployment = database
            .query<{ id: string; team_id: string }, []>(
              "SELECT id, team_id FROM deployments WHERE singleton = 1",
            )
            .get();
          if (!deployment) return error("DEPLOYMENT_NOT_READY", "Deployment is not ready.");
          const inviter = database
            .query<{ display_name: string }, [string]>(
              "SELECT display_name FROM members WHERE id = ?",
            )
            .get(command.actor.memberId);
          if (!inviter) return error("OWNER_REQUIRED", "Owner authorization is required.");
          database
            .query<void, [string, Uint8Array, string, string | null, number, number]>(
              "INSERT INTO invitations(id, token_hash, inviter_id, label, expires_at, revision, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
            )
            .run(
              invitationId,
              tokenHash,
              command.actor.memberId,
              command.label?.trim() ?? null,
              now + INVITATION_LIFETIME,
              now,
            );
          idempotency.storeSecretIssued(
            ticket.value,
            "SECRET_ALREADY_ISSUED",
            "Invitation secret was already issued.",
          );
          audit("INVITATION_CREATED", "MEMBER", command.actor.memberId, invitationId, {
            role: "MEMBER",
          });
          return {
            ok: true,
            value: {
              id: invitationId,
              deploymentId: deployment.id,
              teamId: deployment.team_id,
              inviterId: command.actor.memberId,
              inviterDisplayName: inviter.display_name,
              role: "MEMBER",
              ...(command.label ? { label: command.label.trim() } : {}),
              expiresAt: (now + INVITATION_LIFETIME) as never,
              state: "PENDING",
              secret: rawSecret,
            },
          } as const;
        });
      } catch {
        return reject(
          "INVITATION_CREATE",
          "IDENTITY_OPERATION_FAILED",
          "Identity operation failed.",
        );
      }
    },

    async exchangeInvitation(command) {
      if (!validIdempotencyKey(command.idempotencyKey))
        return reject(
          "INVITATION_EXCHANGE",
          "IDENTITY_INPUT_INVALID",
          "Identity input is invalid.",
        );
      if (command.secret.length < 32 || command.secret.length > 512)
        return reject("INVITATION_EXCHANGE", "INVITATION_INVALID", "Invitation is invalid.");
      const tokenHash = await digest(command.secret);
      const invitation = database
        .query<InvitationRow, [Uint8Array]>(
          `SELECT invitations.*, invitation_exchange_sessions.id AS exchange_id,
                  deployments.id AS deployment_id, deployments.team_id AS team_id,
                  members.display_name AS inviter_display_name
           FROM invitations
           LEFT JOIN invitation_exchange_sessions ON invitation_exchange_sessions.invitation_id = invitations.id
           JOIN members ON members.id = invitations.inviter_id
           CROSS JOIN deployments
           WHERE invitations.token_hash = ?`,
        )
        .get(tokenHash);
      if (!invitation)
        return reject("INVITATION_EXCHANGE", "INVITATION_INVALID", "Invitation is invalid.");
      const ticket = await idempotency.ticket(
        "INVITATION_EXCHANGE",
        `INVITATION_${invitation.id}`,
        command.idempotencyKey,
        command,
      );
      if (!ticket.ok) return ticket;
      const replay = idempotency.replay<never>(ticket.value);
      if (replay) return replay;
      if (invitation.consumed_at !== null)
        return reject("INVITATION_EXCHANGE", "INVITATION_USED", "Invitation was already used.");
      if (invitation.revoked_at !== null)
        return reject("INVITATION_EXCHANGE", "INVITATION_REVOKED", "Invitation was revoked.");
      if (clock() >= invitation.expires_at)
        return reject("INVITATION_EXCHANGE", "INVITATION_EXPIRED", "Invitation expired.");
      if (invitation.exchange_id)
        return reject(
          "INVITATION_EXCHANGE",
          "INVITATION_EXCHANGED",
          "Invitation was already exchanged.",
        );
      const rawSession = base64Url(randomBytes(32));
      const sessionHash = await digest(rawSession);
      try {
        return auditedTransaction("INVITATION_EXCHANGE", () => {
          const committedReplay = idempotency.replay<never>(ticket.value);
          if (committedReplay) return committedReplay;
          const current = getInvitation(invitation.id);
          if (
            !current ||
            current.revision !== invitation.revision ||
            current.consumed_at !== null ||
            current.revoked_at !== null ||
            clock() >= current.expires_at
          )
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          if (current.exchange_id)
            return error("INVITATION_EXCHANGED", "Invitation was already exchanged.");
          const now = clock();
          const exchangeId = id("invitation_session");
          database
            .query<void, [string, string, Uint8Array, number, number]>(
              "INSERT INTO invitation_exchange_sessions(id, invitation_id, session_hash, revision, created_at, expires_at) VALUES (?, ?, ?, 1, ?, ?)",
            )
            .run(exchangeId, invitation.id, sessionHash, now, now + INVITATION_SESSION_LIFETIME);
          idempotency.storeSecretIssued(
            ticket.value,
            "SECRET_ALREADY_ISSUED",
            "Invitation session secret was already issued.",
          );
          audit("INVITATION_EXCHANGED", "INVITATION", invitation.id, exchangeId, {});
          return {
            ok: true,
            value: {
              invitationId: invitation.id,
              secret: rawSession,
              expiresAt: (now + INVITATION_SESSION_LIFETIME) as never,
              httpOnly: true as const,
            },
          };
        });
      } catch {
        return reject(
          "INVITATION_EXCHANGE",
          "INVITATION_EXCHANGED",
          "Invitation was already exchanged.",
        );
      }
    },

    async inspectInvitation(query) {
      if (!(await requireOwner(query.actor)).ok)
        return error("OWNER_REQUIRED", "Owner authorization is required.");
      const row = getInvitation(query.invitationId);
      return row
        ? { ok: true, value: invitationView(row) }
        : error("INVITATION_NOT_FOUND", "Invitation was not found.");
    },

    async revokeInvitation(command) {
      if (!validIdempotencyKey(command.idempotencyKey))
        return reject("INVITATION_REVOKE", "IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const ticket = await idempotency.ticket(
        "INVITATION_REVOKE",
        `MEMBER_${command.actor.memberId}`,
        command.idempotencyKey,
        command,
      );
      if (!ticket.ok) return ticket;
      const replay = idempotency.replay(ticket.value, TeamInvitationReplaySchema);
      if (replay) return replay;
      const resolvedAuthority = await memberAuthority(command.actor);
      const authority = resolvedAuthority?.member;
      if (!resolvedAuthority || authority?.role !== "OWNER")
        return reject("INVITATION_REVOKE", "OWNER_REQUIRED", "Owner authorization is required.");
      const authorityProofHash = resolvedAuthority.proofHash;
      try {
        return auditedTransaction("INVITATION_REVOKE", () => {
          const committedReplay = idempotency.replay(ticket.value, TeamInvitationReplaySchema);
          if (committedReplay) return committedReplay;
          const currentAuthority = activeMember(command.actor, authorityProofHash);
          if (
            currentAuthority?.role !== "OWNER" ||
            currentAuthority.memberRevision !== authority.memberRevision ||
            currentAuthority.sessionRevision !== authority.sessionRevision
          )
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          const row = getInvitation(command.invitationId);
          if (!row) return error("INVITATION_NOT_FOUND", "Invitation was not found.");
          if (row.consumed_at !== null)
            return error("INVITATION_USED", "Invitation was already used.");
          if (row.revoked_at !== null) {
            const result = { ok: true, value: invitationView(row) } as const;
            idempotency.storeResult(ticket.value, result);
            return result;
          }
          const now = clock();
          database
            .query<void, [number, string]>(
              "UPDATE invitations SET revoked_at = ?, revision = revision + 1 WHERE id = ?",
            )
            .run(now, row.id);
          database
            .query<void, [number, string]>(
              "UPDATE invitation_exchange_sessions SET revoked_at = ?, revision = revision + 1 WHERE invitation_id = ? AND consumed_at IS NULL AND revoked_at IS NULL",
            )
            .run(now, row.id);
          audit("INVITATION_REVOKED", "MEMBER", command.actor.memberId, row.id, {});
          const result = {
            ok: true,
            value: { ...invitationView(row), state: "REVOKED" as const },
          } as const;
          idempotency.storeResult(ticket.value, result);
          return result;
        });
      } catch {
        return reject(
          "INVITATION_REVOKE",
          "IDENTITY_OPERATION_FAILED",
          "Identity operation failed.",
        );
      }
    },

    async accept(command: AcceptInvitationWithVerifiedIdentity) {
      if (!validIdempotencyKey(command.idempotencyKey))
        return reject("INVITATION_ACCEPT", "IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      if (!validText(command.displayName) || !validText(command.credentialName))
        return reject("INVITATION_ACCEPT", "IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const exchange = await exchangeBySecret(command.invitationSessionSecret);
      if (!exchange)
        return reject(
          "INVITATION_ACCEPT",
          "INVITATION_SESSION_INVALID",
          "Invitation session is invalid.",
        );
      const ticket = await idempotency.ticket(
        "INVITATION_ACCEPT",
        `INVITATION_${exchange.id}`,
        command.idempotencyKey,
        command,
      );
      if (!ticket.ok) {
        auditFailure("INVITATION_ACCEPT", ticket.error.code);
        return ticket;
      }
      const replay = idempotency.replay<never>(ticket.value);
      if (replay) return replay;
      if (exchange.consumed_at !== null)
        return reject("INVITATION_ACCEPT", "INVITATION_USED", "Invitation was already used.");
      if (exchange.revoked_at !== null || clock() >= exchange.expires_at)
        return reject(
          "INVITATION_ACCEPT",
          "INVITATION_SESSION_INVALID",
          "Invitation session is invalid.",
        );
      const invitationSnapshot = getInvitation(exchange.invitation_id);
      if (
        !invitationSnapshot ||
        invitationSnapshot.consumed_at !== null ||
        invitationSnapshot.revoked_at !== null ||
        clock() >= invitationSnapshot.expires_at
      )
        return reject(
          "INVITATION_ACCEPT",
          "INVITATION_SESSION_INVALID",
          "Invitation session is invalid.",
        );
      const status = challengeStatus(challenge(command.challengeId), "PASSKEY_REGISTRATION");
      if (!status.ok) {
        auditFailure("INVITATION_ACCEPT", status.error.code);
        return status;
      }
      if (status.value.invitation_exchange_session_id !== exchange.id)
        return reject("INVITATION_ACCEPT", "CHALLENGE_INVALID", "Passkey challenge is invalid.");
      const verified = await verifyRegistration(status.value, command.response);
      if (!verified.ok) {
        auditFailure("INVITATION_ACCEPT", verified.error.code);
        return verified;
      }
      const opaqueUserId = (await digest(`invitation:${exchange.id}`)).slice(0, 32);
      const sessionProof = base64Url(randomBytes(32));
      const sessionProofHash = await digest(sessionProof);
      try {
        return auditedTransaction("INVITATION_ACCEPT", () => {
          const committedReplay = idempotency.replay<never>(ticket.value);
          if (committedReplay) return committedReplay;
          const currentExchange = database
            .query<ExchangeRow, [string]>(
              "SELECT id, invitation_id, revision, expires_at, consumed_at, revoked_at FROM invitation_exchange_sessions WHERE id = ?",
            )
            .get(exchange.id);
          const currentInvitation = getInvitation(exchange.invitation_id);
          if (
            !currentExchange ||
            currentExchange.revision !== exchange.revision ||
            currentExchange.consumed_at !== null ||
            currentInvitation?.consumed_at !== null ||
            currentInvitation?.revision !== invitationSnapshot.revision
          )
            return error("INVITATION_USED", "Invitation was already used.");
          if (
            !currentInvitation ||
            currentInvitation.revoked_at !== null ||
            clock() >= currentInvitation.expires_at ||
            clock() >= currentExchange.expires_at
          )
            return error("INVITATION_SESSION_INVALID", "Invitation session is invalid.");
          const currentChallenge = challengeStatus(
            challenge(command.challengeId),
            "PASSKEY_REGISTRATION",
          );
          if (!currentChallenge.ok) return currentChallenge;
          if (currentChallenge.value.revision !== status.value.revision)
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          const now = clock();
          const memberId = id("member");
          const sessionId = id("session");
          database
            .query<void, [string, string, number]>(
              "INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at) VALUES (?, ?, 'MEMBER', 'ACTIVE', 1, 1, ?)",
            )
            .run(memberId, command.displayName.trim(), now);
          insertCredential(memberId, opaqueUserId, command.credentialName.trim(), verified.value);
          database
            .query<void, [string, string, Uint8Array, number]>(
              "INSERT INTO sessions(id, member_id, proof_hash, kind, expires_at, revision) VALUES (?, ?, ?, 'BROWSER', ?, 1)",
            )
            .run(sessionId, memberId, sessionProofHash, now + BROWSER_SESSION_LIFETIME);
          database
            .query<void, [number, string]>(
              "UPDATE invitations SET consumed_at = ?, revision = revision + 1 WHERE id = ?",
            )
            .run(now, exchange.invitation_id);
          database
            .query<void, [number, string]>(
              "UPDATE invitation_exchange_sessions SET consumed_at = ?, revision = revision + 1 WHERE id = ?",
            )
            .run(now, exchange.id);
          database
            .query<void, [number, string]>(
              "UPDATE webauthn_challenges SET consumed_at = ?, revision = revision + 1 WHERE id = ?",
            )
            .run(now, command.challengeId);
          audit("INVITATION_ACCEPTED", "INVITATION", exchange.invitation_id, memberId, {
            role: "MEMBER",
          });
          const result = {
            ok: true,
            value: sessionIssue(sessionId, memberId, now + BROWSER_SESSION_LIFETIME, sessionProof),
          } as const;
          idempotency.storeSecretIssued(
            ticket.value,
            "SECRET_ALREADY_ISSUED",
            "Browser session proof was already issued.",
          );
          return result;
        });
      } catch {
        return reject(
          "INVITATION_ACCEPT",
          "IDENTITY_OPERATION_FAILED",
          "Identity operation failed.",
        );
      }
    },

    async generateRecoveryCodes(command) {
      if (!validIdempotencyKey(command.idempotencyKey))
        return reject("RECOVERY_GENERATE", "IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const ticket = await idempotency.ticket(
        "RECOVERY_GENERATE",
        `MEMBER_${command.actor.memberId}`,
        command.idempotencyKey,
        command,
      );
      if (!ticket.ok) return ticket;
      const replay = idempotency.replay<never>(ticket.value);
      if (replay) return replay;
      const resolvedAuthority = await memberAuthority(command.actor);
      const authority = resolvedAuthority?.member;
      if (!authority)
        return reject("RECOVERY_GENERATE", "SESSION_INVALID", "Member session is invalid.");
      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => base64Url(randomBytes(24)));
      const salts = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(16));
      const hashes = await Promise.all(
        codes.map((code, index) => deriveSecret(code, salts[index] as Uint8Array)),
      );
      try {
        return auditedTransaction("RECOVERY_GENERATE", () => {
          const committedReplay = idempotency.replay<never>(ticket.value);
          if (committedReplay) return committedReplay;
          const currentAuthority = activeMember(command.actor, resolvedAuthority.proofHash);
          if (
            !currentAuthority ||
            currentAuthority.memberRevision !== authority.memberRevision ||
            currentAuthority.sessionRevision !== authority.sessionRevision
          )
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          const now = clock();
          const prior = database
            .query<{ generation: number }, [string]>(
              "SELECT generation FROM recovery_code_sets WHERE member_id = ? ORDER BY generation DESC LIMIT 1",
            )
            .get(command.actor.memberId);
          const generation = (prior?.generation ?? 0) + 1;
          database
            .query<void, [number, string]>(
              "UPDATE recovery_code_sets SET revoked_at = ?, revision = revision + 1 WHERE member_id = ? AND revoked_at IS NULL",
            )
            .run(now, command.actor.memberId);
          database
            .query<void, [number, string]>(
              "UPDATE recovery_codes SET revoked_at = ?, revision = revision + 1 WHERE recovery_code_set_id IN (SELECT id FROM recovery_code_sets WHERE member_id = ?) AND consumed_at IS NULL AND revoked_at IS NULL",
            )
            .run(now, command.actor.memberId);
          const setId = id("recovery_set");
          database
            .query<void, [string, string, number, number]>(
              "INSERT INTO recovery_code_sets(id, member_id, generation, revision, created_at) VALUES (?, ?, ?, 1, ?)",
            )
            .run(setId, command.actor.memberId, generation, now);
          const insert = database.query<
            void,
            [string, string, number, Uint8Array, Uint8Array, number]
          >(
            "INSERT INTO recovery_codes(id, recovery_code_set_id, code_index, salt, code_hash, revision, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
          );
          hashes.forEach((hash, index) => {
            insert.run(id("recovery_code"), setId, index, salts[index] as Uint8Array, hash, now);
          });
          idempotency.storeSecretIssued(
            ticket.value,
            "SECRET_ALREADY_ISSUED",
            "Recovery codes were already issued.",
          );
          audit("RECOVERY_CODES_GENERATED", "MEMBER", command.actor.memberId, setId, {
            generation,
          });
          return { ok: true, value: { generation, codes, createdAt: now as never } };
        });
      } catch {
        return reject(
          "RECOVERY_GENERATE",
          "IDENTITY_OPERATION_FAILED",
          "Identity operation failed.",
        );
      }
    },

    async redeemRecoveryCode(command) {
      if (
        !validIdempotencyKey(command.idempotencyKey) ||
        command.code.length < 24 ||
        command.code.length > 512
      )
        return reject("RECOVERY_REDEEM", "RECOVERY_CODE_INVALID", "Recovery code is invalid.");
      const ticket = await idempotency.ticket(
        "RECOVERY_REDEEM",
        `RECOVERY_MEMBER_${command.memberId}`,
        command.idempotencyKey,
        command,
      );
      if (!ticket.ok) return ticket;
      const replay = idempotency.replay<never>(ticket.value);
      if (replay) return replay;
      const memberSnapshot = database
        .query<{ revision: number }, [string]>(
          "SELECT revision FROM members WHERE id = ? AND status = 'ACTIVE'",
        )
        .get(command.memberId);
      if (!memberSnapshot) {
        auditFailure("RECOVERY_REDEEM", "RECOVERY_CODE_INVALID");
        return error("RECOVERY_CODE_INVALID", "Recovery code is invalid.");
      }
      const candidates = database
        .query<
          Readonly<{
            id: string;
            salt: Uint8Array;
            code_hash: Uint8Array;
            revision: number;
            consumed_at: number | null;
            revoked_at: number | null;
            set_id: string;
            set_revision: number;
          }>,
          [string]
        >(
          `SELECT recovery_codes.id, recovery_codes.salt, recovery_codes.code_hash,
                  recovery_codes.revision, recovery_codes.consumed_at, recovery_codes.revoked_at,
                  recovery_code_sets.id AS set_id, recovery_code_sets.revision AS set_revision
           FROM recovery_codes JOIN recovery_code_sets
             ON recovery_code_sets.id = recovery_codes.recovery_code_set_id
           WHERE recovery_code_sets.member_id = ? AND recovery_code_sets.revoked_at IS NULL`,
        )
        .all(command.memberId);
      let matched: (typeof candidates)[number] | undefined;
      for (const candidate of candidates)
        if (
          constantTimeEqual(await deriveSecret(command.code, candidate.salt), candidate.code_hash)
        )
          matched = candidate;
      if (!matched) {
        auditFailure("RECOVERY_REDEEM", "RECOVERY_CODE_INVALID");
        return error("RECOVERY_CODE_INVALID", "Recovery code is invalid.");
      }
      if (matched.consumed_at !== null)
        return reject("RECOVERY_REDEEM", "RECOVERY_CODE_USED", "Recovery code was already used.");
      if (matched.revoked_at !== null)
        return reject("RECOVERY_REDEEM", "RECOVERY_CODE_INVALID", "Recovery code is invalid.");
      const sessionProof = base64Url(randomBytes(32));
      const sessionProofHash = await digest(sessionProof);
      try {
        return auditedTransaction("RECOVERY_REDEEM", () => {
          const committedReplay = idempotency.replay<never>(ticket.value);
          if (committedReplay) return committedReplay;
          const activeMemberRow = database
            .query<{ id: string }, [string, number]>(
              "SELECT id FROM members WHERE id = ? AND status = 'ACTIVE' AND revision = ?",
            )
            .get(command.memberId, memberSnapshot.revision);
          const activeSet = database
            .query<{ id: string }, [string, number]>(
              "SELECT id FROM recovery_code_sets WHERE id = ? AND revision = ? AND revoked_at IS NULL",
            )
            .get(matched.set_id, matched.set_revision);
          if (!activeMemberRow || !activeSet)
            return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
          const now = clock();
          const update = database
            .query<void, [number, string, number]>(
              "UPDATE recovery_codes SET consumed_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND consumed_at IS NULL AND revoked_at IS NULL",
            )
            .run(now, matched.id, matched.revision);
          if (update.changes !== 1)
            return error("RECOVERY_CODE_USED", "Recovery code was already used.");
          const sessionId = id("recovery_session");
          database
            .query<void, [string, string, Uint8Array, number]>(
              "INSERT INTO sessions(id, member_id, proof_hash, kind, expires_at, revision) VALUES (?, ?, ?, 'RECOVERY', ?, 1)",
            )
            .run(sessionId, command.memberId, sessionProofHash, now + RECOVERY_SESSION_LIFETIME);
          audit("RECOVERY_CODE_REDEEMED", "RECOVERY_CODE", command.memberId, sessionId, {});
          const result = {
            ok: true,
            value: {
              kind: "RECOVERY" as const,
              id: sessionId as never,
              memberId: command.memberId,
              expiresAt: (now + RECOVERY_SESSION_LIFETIME) as never,
              proof: sessionProof,
            },
          } as const;
          idempotency.storeSecretIssued(
            ticket.value,
            "SECRET_ALREADY_ISSUED",
            "Recovery session proof was already issued.",
          );
          return result;
        });
      } catch {
        return reject("RECOVERY_REDEEM", "IDENTITY_OPERATION_FAILED", "Identity operation failed.");
      }
    },
  };
}
