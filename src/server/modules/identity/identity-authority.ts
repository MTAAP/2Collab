import type { Database } from "bun:sqlite";
import type {
  AcceptInvitationWithVerifiedIdentity,
  BeginPasskeyRegistration,
  MemberActor,
  MemberSession,
  PasskeyCredential,
  RegistrationPrincipal,
  TeamInvitation,
} from "../../../shared/contracts/identity.ts";
import type { DomainError, Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import type { IdentityAuthority } from "./contract.ts";
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

type ChallengeRow = Readonly<{
  id: string;
  purpose: "PASSKEY_REGISTRATION" | "PASSKEY_AUTHENTICATION";
  challenge_hash: Uint8Array;
  member_id: string | null;
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

function sessionView(id: string, memberId: string, expiresAt: number): MemberSession {
  return {
    id: id as MemberSession["id"],
    memberId: memberId as MemberSession["memberId"],
    expiresAt: expiresAt as MemberSession["expiresAt"],
  };
}

function validateConfiguration(dependencies: IdentityAuthorityDependencies): void {
  let url: URL;
  try {
    url = new URL(dependencies.publicOrigin);
  } catch {
    throw new Error("IDENTITY_CONFIGURATION_INVALID");
  }
  const localhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
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

  const activeMember = (actor: MemberActor): Readonly<{ role: "OWNER" | "MEMBER" }> | null => {
    return database
      .query<Readonly<{ role: "OWNER" | "MEMBER" }>, [string, string, number]>(
        `SELECT members.role FROM members
         JOIN sessions ON sessions.member_id = members.id
         WHERE members.id = ? AND sessions.id = ? AND members.status = 'ACTIVE'
           AND sessions.kind = 'BROWSER' AND sessions.revoked_at IS NULL AND sessions.expires_at > ?`,
      )
      .get(actor.memberId, actor.sessionId, clock());
  };

  const requireOwner = (actor: MemberActor): Result<Readonly<{ role: "OWNER" }>> => {
    const member = activeMember(actor);
    if (member?.role !== "OWNER")
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

  const exchangeBySecret = async (secret: string): Promise<ExchangeRow | null> => {
    if (secret.length < 32 || secret.length > 512) return null;
    const secretHash = await digest(secret);
    return database
      .query<ExchangeRow, [Uint8Array]>(
        "SELECT id, invitation_id, revision, expires_at, consumed_at, revoked_at FROM invitation_exchange_sessions WHERE session_hash = ?",
      )
      .get(secretHash);
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
        },
      };
    }
    if (principal.kind === "INVITATION") {
      const exchange = await exchangeBySecret(principal.secret);
      if (
        !exchange ||
        exchange.consumed_at !== null ||
        exchange.revoked_at !== null ||
        clock() >= exchange.expires_at
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
        },
      };
    }
    if (principal.kind === "RECOVERY") {
      const row = database
        .query<Readonly<{ member_id: string }>, [string, number]>(
          "SELECT member_id FROM sessions WHERE id = ? AND kind = 'RECOVERY' AND revoked_at IS NULL AND expires_at > ?",
        )
        .get(principal.sessionId, clock());
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
        },
      };
    }
    if (!activeMember(principal)) return error("SESSION_INVALID", "Member session is invalid.");
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
      },
    };
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
      if (!validText(command.displayName))
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const principal = await memberForRegistration(command.principal);
      if (!principal.ok) return principal;
      const rawChallenge = base64Url(randomBytes(32));
      const hash = await digest(rawChallenge);
      const challengeId = id("challenge");
      const now = clock();
      try {
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
          challenge: rawChallenge,
          rpName: dependencies.rpName,
          rpId: dependencies.rpId,
          userId: principal.value.opaqueUserId,
          userName: principal.value.memberId ?? "new-member",
          userDisplayName: command.displayName,
          excludeCredentials: excludes,
        });
        return {
          ok: true,
          value: {
            challengeId,
            challenge: rawChallenge,
            expiresAt: (now + CHALLENGE_LIFETIME) as never,
            options,
          },
        };
      } catch {
        database
          .query<void, [string]>("DELETE FROM webauthn_challenges WHERE id = ?")
          .run(challengeId);
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
        return error("BOOTSTRAP_SECRET_INVALID", "Bootstrap secret is invalid.");
      }
      const status = challengeStatus(challenge(command.challengeId), "PASSKEY_REGISTRATION");
      if (!status.ok) return status;
      const binding = await digest(command.bootstrapSecret);
      if (
        !status.value.bootstrap_binding_hash ||
        !constantTimeEqual(binding, status.value.bootstrap_binding_hash)
      )
        return error("CHALLENGE_INVALID", "Passkey challenge is invalid.");
      const verified = await verifyRegistration(status.value, command.response);
      if (!verified.ok) return verified;
      const opaqueUserId = (await digest(`bootstrap:${command.bootstrapSecret}`)).slice(0, 32);
      try {
        return inImmediateTransaction(database, () => {
          if (
            database.query<{ count: number }, []>("SELECT count(*) AS count FROM deployments").get()
              ?.count
          )
            return error("DEPLOYMENT_ALREADY_BOOTSTRAPPED", "Deployment was already bootstrapped.");
          const current = challengeStatus(challenge(command.challengeId), "PASSKEY_REGISTRATION");
          if (!current.ok) return current;
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
            .query<void, [string, string, number]>(
              "INSERT INTO sessions(id, member_id, kind, expires_at, revision) VALUES (?, ?, 'BROWSER', ?, 1)",
            )
            .run(sessionId, memberId, now + BROWSER_SESSION_LIFETIME);
          database
            .query<void, [number, string]>(
              "UPDATE webauthn_challenges SET consumed_at = ?, revision = revision + 1 WHERE id = ? AND consumed_at IS NULL",
            )
            .run(now, command.challengeId);
          audit("DEPLOYMENT_BOOTSTRAPPED", "BOOTSTRAP", deploymentId, memberId, { role: "OWNER" });
          return {
            ok: true,
            value: sessionView(sessionId, memberId, now + BROWSER_SESSION_LIFETIME),
          };
        });
      } catch {
        return error("IDENTITY_OPERATION_FAILED", "Identity operation failed.");
      }
    },

    async finishPasskeyRegistration(command) {
      if (!validText(command.credentialName))
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const principal = await memberForRegistration(command.principal);
      if (!principal.ok || !principal.value.memberId)
        return principal.ok ? error("SESSION_INVALID", "Member session is invalid.") : principal;
      const status = challengeStatus(challenge(command.challengeId), "PASSKEY_REGISTRATION");
      if (!status.ok) return status;
      if (status.value.member_id !== principal.value.memberId)
        return error("CHALLENGE_INVALID", "Passkey challenge is invalid.");
      const verified = await verifyRegistration(status.value, command.response);
      if (!verified.ok) return verified;
      try {
        return inImmediateTransaction(database, () => {
          const current = challengeStatus(challenge(command.challengeId), "PASSKEY_REGISTRATION");
          if (!current.ok) return current;
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
          return { ok: true, value: credential };
        });
      } catch {
        return error("IDENTITY_OPERATION_FAILED", "Identity operation failed.");
      }
    },

    async beginPasskeyAuthentication(command) {
      const credentials = command.credentialId
        ? database
            .query<CredentialRow, [string]>(
              "SELECT * FROM passkey_credentials WHERE credential_id = ? AND revoked_at IS NULL",
            )
            .all(command.credentialId)
        : database
            .query<CredentialRow, []>("SELECT * FROM passkey_credentials WHERE revoked_at IS NULL")
            .all();
      if (command.credentialId && credentials.length === 0)
        return error("PASSKEY_NOT_FOUND", "Passkey was not found.");
      const rawChallenge = base64Url(randomBytes(32));
      const hash = await digest(rawChallenge);
      const challengeId = id("challenge");
      const now = clock();
      database
        .query<void, [string, Uint8Array, string, string, number, number]>(
          `INSERT INTO webauthn_challenges(id, purpose, challenge_hash, rp_id, expected_origin, revision, created_at, expires_at) VALUES (?, 'PASSKEY_AUTHENTICATION', ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          challengeId,
          hash,
          dependencies.rpId,
          dependencies.publicOrigin,
          now,
          now + CHALLENGE_LIFETIME,
        );
      try {
        const options = await webAuthn.generateAuthenticationOptions({
          challenge: rawChallenge,
          rpId: dependencies.rpId,
          allowCredentials: credentials.map((credential) => ({
            id: credential.credential_id,
            transports: database
              .query<{ transport: string }, [string]>(
                "SELECT transport FROM passkey_credential_transports WHERE passkey_credential_id = ?",
              )
              .all(credential.id)
              .map((row) => row.transport),
          })),
        });
        return {
          ok: true,
          value: {
            challengeId,
            challenge: rawChallenge,
            expiresAt: (now + CHALLENGE_LIFETIME) as never,
            options,
          },
        };
      } catch {
        database
          .query<void, [string]>("DELETE FROM webauthn_challenges WHERE id = ?")
          .run(challengeId);
        return error("PASSKEY_OPERATION_FAILED", "Passkey operation failed.");
      }
    },

    async authenticate(command) {
      if (!validIdempotencyKey(command.idempotencyKey))
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const status = challengeStatus(challenge(command.challengeId), "PASSKEY_AUTHENTICATION");
      if (!status.ok) return status;
      const response = command.response as { id?: string; credentialId?: string };
      const publicId = response.id ?? response.credentialId;
      if (!publicId || publicId.length > 1366)
        return error("PASSKEY_VERIFICATION_FAILED", "Passkey verification failed.");
      const credential = database
        .query<CredentialRow, [string]>(
          "SELECT * FROM passkey_credentials WHERE credential_id = ? AND revoked_at IS NULL",
        )
        .get(publicId);
      if (!credential) return error("PASSKEY_VERIFICATION_FAILED", "Passkey verification failed.");
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
        if (!verified.verified)
          return error("PASSKEY_VERIFICATION_FAILED", "Passkey verification failed.");
        return inImmediateTransaction(database, () => {
          const current = challengeStatus(challenge(command.challengeId), "PASSKEY_AUTHENTICATION");
          if (!current.ok) return current;
          const now = clock();
          const update = database
            .query<void, [number, number, number, string, number]>(
              "UPDATE passkey_credentials SET signature_counter = ?, backup_state = ?, last_used_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND revoked_at IS NULL",
            )
            .run(
              verified.newCounter,
              verified.backedUp ? 1 : 0,
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
            .query<void, [string, string, number]>(
              "INSERT INTO sessions(id, member_id, kind, expires_at, revision) VALUES (?, ?, 'BROWSER', ?, 1)",
            )
            .run(sessionId, credential.member_id, now + BROWSER_SESSION_LIFETIME);
          database
            .query<void, [number, string]>(
              "UPDATE webauthn_challenges SET consumed_at = ?, revision = revision + 1 WHERE id = ?",
            )
            .run(now, command.challengeId);
          audit("PASSKEY_AUTHENTICATED", "PASSKEY", credential.member_id, credential.id, {
            counterUpdated: true,
          });
          return {
            ok: true,
            value: sessionView(sessionId, credential.member_id, now + BROWSER_SESSION_LIFETIME),
          };
        });
      } catch {
        return error("PASSKEY_VERIFICATION_FAILED", "Passkey verification failed.");
      }
    },

    async revokePasskey(command) {
      if (!activeMember(command.actor))
        return error("SESSION_INVALID", "Member session is invalid.");
      try {
        return inImmediateTransaction(database, () => {
          const now = clock();
          const update = database
            .query<void, [number, string, string, number]>(
              "UPDATE passkey_credentials SET revoked_at = ?, revision = revision + 1 WHERE id = ? AND member_id = ? AND revision = ? AND revoked_at IS NULL",
            )
            .run(now, command.credentialId, command.actor.memberId, command.expectedRevision);
          if (update.changes !== 1) return error("PASSKEY_STALE", "Passkey state changed.");
          audit("PASSKEY_REVOKED", "MEMBER", command.actor.memberId, command.credentialId, {});
          return {
            ok: true,
            value: {
              credentialId: command.credentialId,
              revokedAt: now as never,
              revision: command.expectedRevision + 1,
            },
          };
        });
      } catch {
        return error("IDENTITY_OPERATION_FAILED", "Identity operation failed.");
      }
    },

    async listPasskeys(query) {
      if (!activeMember(query.actor)) return error("SESSION_INVALID", "Member session is invalid.");
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
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      if (!requireOwner(command.actor).ok)
        return error("OWNER_REQUIRED", "Owner authorization is required.");
      if (command.label !== undefined && !validText(command.label))
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const rawSecret = base64Url(randomBytes(32));
      const tokenHash = await digest(rawSecret);
      const now = clock();
      try {
        return inImmediateTransaction(database, () => {
          const replay = database
            .query<{ result_json: string }, [string, string]>(
              "SELECT result_json FROM idempotency_results WHERE actor_id = ? AND idempotency_key = ?",
            )
            .get(command.actor.memberId, command.idempotencyKey);
          if (replay)
            return error("SECRET_ALREADY_ISSUED", "Invitation secret was already issued.");
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
          database
            .query<void, [string, string, string, string, number]>(
              "INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              command.actor.memberId,
              command.idempotencyKey,
              "INVITATION_CREATE",
              JSON.stringify({ invitationId, secretIssued: true }),
              now,
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
          };
        });
      } catch {
        return error("IDENTITY_OPERATION_FAILED", "Identity operation failed.");
      }
    },

    async exchangeInvitation(command) {
      if (!validIdempotencyKey(command.idempotencyKey))
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      if (command.secret.length < 32 || command.secret.length > 512)
        return error("INVITATION_INVALID", "Invitation is invalid.");
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
      if (!invitation) return error("INVITATION_INVALID", "Invitation is invalid.");
      if (invitation.consumed_at !== null)
        return error("INVITATION_USED", "Invitation was already used.");
      if (invitation.revoked_at !== null)
        return error("INVITATION_REVOKED", "Invitation was revoked.");
      if (clock() >= invitation.expires_at)
        return error("INVITATION_EXPIRED", "Invitation expired.");
      if (invitation.exchange_id)
        return error("INVITATION_EXCHANGED", "Invitation was already exchanged.");
      const rawSession = base64Url(randomBytes(32));
      const sessionHash = await digest(rawSession);
      try {
        return inImmediateTransaction(database, () => {
          const current = getInvitation(invitation.id);
          if (current?.exchange_id)
            return error("INVITATION_EXCHANGED", "Invitation was already exchanged.");
          const now = clock();
          const exchangeId = id("invitation_session");
          database
            .query<void, [string, string, Uint8Array, number, number]>(
              "INSERT INTO invitation_exchange_sessions(id, invitation_id, session_hash, revision, created_at, expires_at) VALUES (?, ?, ?, 1, ?, ?)",
            )
            .run(exchangeId, invitation.id, sessionHash, now, now + INVITATION_SESSION_LIFETIME);
          database
            .query<void, [string, string, string, string, number]>(
              "INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              `INVITATION_${invitation.id}`,
              command.idempotencyKey,
              "INVITATION_EXCHANGE",
              JSON.stringify({ invitationId: invitation.id, sessionIssued: true }),
              now,
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
        return error("INVITATION_EXCHANGED", "Invitation was already exchanged.");
      }
    },

    async inspectInvitation(query) {
      if (!requireOwner(query.actor).ok)
        return error("OWNER_REQUIRED", "Owner authorization is required.");
      const row = getInvitation(query.invitationId);
      return row
        ? { ok: true, value: invitationView(row) }
        : error("INVITATION_NOT_FOUND", "Invitation was not found.");
    },

    async revokeInvitation(command) {
      if (!requireOwner(command.actor).ok)
        return error("OWNER_REQUIRED", "Owner authorization is required.");
      try {
        return inImmediateTransaction(database, () => {
          const row = getInvitation(command.invitationId);
          if (!row) return error("INVITATION_NOT_FOUND", "Invitation was not found.");
          if (row.consumed_at !== null)
            return error("INVITATION_USED", "Invitation was already used.");
          if (row.revoked_at !== null) return { ok: true, value: invitationView(row) };
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
          return { ok: true, value: { ...invitationView(row), state: "REVOKED" } };
        });
      } catch {
        return error("IDENTITY_OPERATION_FAILED", "Identity operation failed.");
      }
    },

    async accept(command: AcceptInvitationWithVerifiedIdentity) {
      if (!validIdempotencyKey(command.idempotencyKey))
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      if (!validText(command.displayName) || !validText(command.credentialName))
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      const exchange = await exchangeBySecret(command.invitationSessionSecret);
      if (!exchange) return error("INVITATION_SESSION_INVALID", "Invitation session is invalid.");
      if (exchange.consumed_at !== null)
        return error("INVITATION_USED", "Invitation was already used.");
      if (exchange.revoked_at !== null || clock() >= exchange.expires_at)
        return error("INVITATION_SESSION_INVALID", "Invitation session is invalid.");
      const status = challengeStatus(challenge(command.challengeId), "PASSKEY_REGISTRATION");
      if (!status.ok) return status;
      if (status.value.invitation_exchange_session_id !== exchange.id)
        return error("CHALLENGE_INVALID", "Passkey challenge is invalid.");
      const verified = await verifyRegistration(status.value, command.response);
      if (!verified.ok) return verified;
      const opaqueUserId = (await digest(`invitation:${exchange.id}`)).slice(0, 32);
      try {
        return inImmediateTransaction(database, () => {
          const currentExchange = database
            .query<ExchangeRow, [string]>(
              "SELECT id, invitation_id, revision, expires_at, consumed_at, revoked_at FROM invitation_exchange_sessions WHERE id = ?",
            )
            .get(exchange.id);
          const currentInvitation = getInvitation(exchange.invitation_id);
          if (
            !currentExchange ||
            currentExchange.consumed_at !== null ||
            currentInvitation?.consumed_at !== null
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
            .query<void, [string, string, number]>(
              "INSERT INTO sessions(id, member_id, kind, expires_at, revision) VALUES (?, ?, 'BROWSER', ?, 1)",
            )
            .run(sessionId, memberId, now + BROWSER_SESSION_LIFETIME);
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
          return {
            ok: true,
            value: sessionView(sessionId, memberId, now + BROWSER_SESSION_LIFETIME),
          };
        });
      } catch {
        return error("IDENTITY_OPERATION_FAILED", "Identity operation failed.");
      }
    },

    async generateRecoveryCodes(command) {
      if (!validIdempotencyKey(command.idempotencyKey))
        return error("IDENTITY_INPUT_INVALID", "Identity input is invalid.");
      if (!activeMember(command.actor))
        return error("SESSION_INVALID", "Member session is invalid.");
      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => base64Url(randomBytes(24)));
      const salts = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(16));
      const hashes = await Promise.all(
        codes.map((code, index) => deriveSecret(code, salts[index] as Uint8Array)),
      );
      try {
        return inImmediateTransaction(database, () => {
          const replay = database
            .query<{ result_json: string }, [string, string]>(
              "SELECT result_json FROM idempotency_results WHERE actor_id = ? AND idempotency_key = ?",
            )
            .get(command.actor.memberId, command.idempotencyKey);
          if (replay) return error("SECRET_ALREADY_ISSUED", "Recovery codes were already issued.");
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
          database
            .query<void, [string, string, string, string, number]>(
              "INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              command.actor.memberId,
              command.idempotencyKey,
              "RECOVERY_GENERATE",
              JSON.stringify({ generation, codesIssued: true }),
              now,
            );
          audit("RECOVERY_CODES_GENERATED", "MEMBER", command.actor.memberId, setId, {
            generation,
          });
          return { ok: true, value: { generation, codes, createdAt: now as never } };
        });
      } catch {
        return error("IDENTITY_OPERATION_FAILED", "Identity operation failed.");
      }
    },

    async redeemRecoveryCode(command) {
      if (command.code.length < 24 || command.code.length > 512)
        return error("RECOVERY_CODE_INVALID", "Recovery code is invalid.");
      const candidates = database
        .query<
          Readonly<{
            id: string;
            salt: Uint8Array;
            code_hash: Uint8Array;
            revision: number;
            consumed_at: number | null;
            revoked_at: number | null;
          }>,
          [string]
        >(
          `SELECT recovery_codes.id, recovery_codes.salt, recovery_codes.code_hash, recovery_codes.revision, recovery_codes.consumed_at, recovery_codes.revoked_at FROM recovery_codes JOIN recovery_code_sets ON recovery_code_sets.id = recovery_codes.recovery_code_set_id WHERE recovery_code_sets.member_id = ? AND recovery_code_sets.revoked_at IS NULL`,
        )
        .all(command.memberId);
      let matched: (typeof candidates)[number] | undefined;
      for (const candidate of candidates)
        if (
          constantTimeEqual(await deriveSecret(command.code, candidate.salt), candidate.code_hash)
        )
          matched = candidate;
      if (!matched) return error("RECOVERY_CODE_INVALID", "Recovery code is invalid.");
      if (matched.consumed_at !== null)
        return error("RECOVERY_CODE_USED", "Recovery code was already used.");
      if (matched.revoked_at !== null)
        return error("RECOVERY_CODE_INVALID", "Recovery code is invalid.");
      try {
        return inImmediateTransaction(database, () => {
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
            .query<void, [string, string, number]>(
              "INSERT INTO sessions(id, member_id, kind, expires_at, revision) VALUES (?, ?, 'RECOVERY', ?, 1)",
            )
            .run(sessionId, command.memberId, now + RECOVERY_SESSION_LIFETIME);
          audit("RECOVERY_CODE_REDEEMED", "RECOVERY_CODE", command.memberId, sessionId, {});
          return {
            ok: true,
            value: {
              kind: "RECOVERY" as const,
              id: sessionId as never,
              memberId: command.memberId,
              expiresAt: (now + RECOVERY_SESSION_LIFETIME) as never,
            },
          };
        });
      } catch {
        return error("IDENTITY_OPERATION_FAILED", "Identity operation failed.");
      }
    },
  };
}
