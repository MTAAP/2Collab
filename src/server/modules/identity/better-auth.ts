import type { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, emailOTP } from "better-auth/plugins";
import type { MemberActor, VerifiedDevicePrincipal } from "../../../shared/contracts/actors.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import {
  normalizeRegistrationEmail,
  type RegistrationPolicyService,
} from "./registration-policy.ts";

const BROWSER_ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;
const BROWSER_IDLE_SECONDS = 12 * 60 * 60;
const CLI_DEVICE_SECONDS = 10 * 60;
const AUTH_FAILURE_AUDIT_LIMIT_PER_MINUTE = 10;
const EMAIL_OTP_TICKET_SECONDS = 5 * 60;
const EMAIL_OTP_SENDS_PER_MINUTE = 3;
export const COLLAB_CLI_CLIENT_ID = "2collab-cli";
export const COLLAB_CLI_SCOPE = "collab:cli";

type SessionPurpose = "BROWSER" | "CLI_DEVICE";

export type EmailOtpTransport = Readonly<{
  send(input: Readonly<{ email: string; otp: string }>): Promise<void>;
}>;

export type CollabEmailOtpPort = Readonly<{
  request(
    input: Readonly<{
      email: string;
      displayName?: string;
      invitationExchangeSessionId?: string;
    }>,
  ): Promise<void>;
  verify(
    input: Readonly<{
      email: string;
      otp: string;
      invitationExchangeSessionId?: string;
    }>,
  ): Promise<Result<Readonly<{ memberId: string; headers: Headers }>>>;
  enrollRequest(
    input: Readonly<{ email: string; request: Request }>,
  ): Promise<Result<Readonly<{ accepted: true }>>>;
  enrollVerify(
    input: Readonly<{ email: string; otp: string; request: Request }>,
  ): Promise<Result<Readonly<{ memberId: string; headers: Headers }>>>;
}>;

type CollabAuthenticationPort = Readonly<{
  authenticateBrowser(request: Request): Promise<Result<MemberActor>>;
  authenticateDevice(request: Request): Promise<Result<MemberActor>>;
  authenticateRunnerDevice(request: Request): Promise<Result<VerifiedDevicePrincipal>>;
  verifyBrowserMutation(request: Request, actor: MemberActor): boolean;
}>;

type AuthSession = Readonly<{
  id: string;
  token: string;
  userId: string;
  expiresAt: Date;
  updatedAt: Date;
  purpose: SessionPurpose;
  memberAuthorityEpoch: number;
  absoluteExpiresAt: Date;
}>;

type LinkedSession = Readonly<{
  session: AuthSession;
  memberId: string;
  memberAuthorityEpoch: number;
}>;

function sha256(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = sha256(left);
  const rightHash = sha256(right);
  return timingSafeEqual(leftHash, rightHash);
}

function failure(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function createCollabBetterAuth(
  input: Readonly<{
    database: Database;
    publicBaseUrl: string;
    rpId: string;
    rpName: string;
    secret: string;
    emailOtp?: Readonly<{
      transport: EmailOtpTransport;
      registrationPolicy: Pick<RegistrationPolicyService, "authorize">;
    }>;
    clock?: () => number;
    id?: (prefix: string) => string;
  }>,
) {
  const now = input.clock ?? (() => Math.floor(Date.now() / 1_000));
  const id = input.id ?? ((prefix: string) => `${prefix}_${randomUUID()}`);
  const failureAuditWindows = new Map<string, { count: number; startedAt: number }>();
  const emailSendLocks = new Map<string, Promise<void>>();
  const emailDeliveryQueues = new Map<string, Promise<void>>();
  const audit = (
    event: Readonly<{
      kind: string;
      actorKind: string;
      actorId: string;
      subjectId?: string;
      safeDetails: Readonly<Record<string, boolean | number | string>>;
    }>,
  ) => {
    input.database
      .query(
        `INSERT INTO audit_events(
           id, kind, actor_kind, actor_id, subject_id, safe_details, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id("audit"),
        event.kind,
        event.actorKind,
        event.actorId,
        event.subjectId ?? null,
        JSON.stringify(event.safeDetails),
        now(),
      );
  };
  const auditAuthenticationFailure = (
    surface:
      | "BROWSER"
      | "CLI_DEVICE"
      | "RUNNER_PAIRING"
      | "PASSKEY"
      | "DEVICE_EXCHANGE"
      | "EMAIL_OTP",
    reason: "MIXED_MODE" | "SESSION_REJECTED" | "ENDPOINT_REJECTED",
  ) => {
    const key = `${surface}:${reason}`;
    const current = now();
    const window = failureAuditWindows.get(key);
    if (!window || current - window.startedAt >= 60) {
      failureAuditWindows.set(key, { count: 1, startedAt: current });
    } else {
      if (window.count >= AUTH_FAILURE_AUDIT_LIMIT_PER_MINUTE) return;
      window.count += 1;
    }
    audit({
      kind: "AUTHENTICATION_FAILED",
      actorKind: "SYSTEM",
      actorId: "AUTH_BOUNDARY",
      safeDetails: { surface, reason },
    });
  };
  const linkedMember = (userId: string) =>
    input.database
      .query<{ member_id: string; authority_epoch: number; snapshot: number }, [string]>(
        `SELECT links.member_id, members.authority_epoch, links.authority_epoch_snapshot AS snapshot
         FROM auth_member_links AS links
         JOIN members ON members.id = links.member_id
         WHERE links.auth_user_id = ? AND links.revoked_at IS NULL AND members.status = 'ACTIVE'`,
      )
      .get(userId);

  const emailDigest = (email: string) =>
    createHmac("sha256", input.secret).update(email, "utf8").digest();
  const reserveEmailSend = (email: string): boolean => {
    const digest = emailDigest(email);
    const current = now();
    return inImmediateTransaction(input.database, () => {
      const window = input.database
        .query<{ window_started_at: number; send_count: number }, [Uint8Array]>(
          `SELECT window_started_at, send_count
           FROM auth_email_send_windows WHERE email_digest = ?`,
        )
        .get(digest);
      if (!window) {
        input.database
          .query(
            `INSERT INTO auth_email_send_windows(
               email_digest, window_started_at, send_count, updated_at
             ) VALUES (?, ?, 1, ?)`,
          )
          .run(digest, current, current);
        return true;
      }
      if (current - window.window_started_at >= 60) {
        input.database
          .query(
            `UPDATE auth_email_send_windows
             SET window_started_at = ?, send_count = 1, updated_at = ?
             WHERE email_digest = ?`,
          )
          .run(current, current, digest);
        return true;
      }
      if (window.send_count >= EMAIL_OTP_SENDS_PER_MINUTE) return false;
      const changed = input.database
        .query(
          `UPDATE auth_email_send_windows SET send_count = send_count + 1, updated_at = ?
           WHERE email_digest = ? AND window_started_at = ? AND send_count = ?`,
        )
        .run(current, digest, window.window_started_at, window.send_count);
      return changed.changes === 1;
    });
  };
  const withEmailSendLock = async <T>(email: string, operation: () => Promise<T>): Promise<T> => {
    const key = emailDigest(email).toString("base64url");
    const previous = emailSendLocks.get(key) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    emailSendLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (emailSendLocks.get(key) === tail) emailSendLocks.delete(key);
    }
  };
  const queueEmailDelivery = (email: string, otp: string): void => {
    if (!input.emailOtp) return;
    const key = emailDigest(email).toString("base64url");
    const previous = emailDeliveryQueues.get(key) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => input.emailOtp?.transport.send({ email, otp }))
      .catch(() => {
        auditAuthenticationFailure("EMAIL_OTP", "ENDPOINT_REJECTED");
      })
      .then(() => {
        if (emailDeliveryQueues.get(key) === queued) emailDeliveryQueues.delete(key);
      });
    emailDeliveryQueues.set(key, queued);
  };

  const activeInvitationExchange = (exchangeId: string | undefined) => {
    if (!exchangeId) return null;
    const current = now();
    return input.database
      .query<{ exchange_id: string; invitation_id: string }, [string, number, number]>(
        `SELECT exchange.id AS exchange_id, invitations.id AS invitation_id
         FROM invitation_exchange_sessions AS exchange
         JOIN invitations ON invitations.id = exchange.invitation_id
         WHERE exchange.id = ? AND exchange.consumed_at IS NULL
           AND exchange.revoked_at IS NULL AND exchange.expires_at > ?
           AND invitations.consumed_at IS NULL AND invitations.revoked_at IS NULL
           AND invitations.expires_at > ?`,
      )
      .get(exchangeId, current, current);
  };

  const authorizeEmailTicket = (
    ticket: Readonly<{
      normalized_email: string;
      authorization_kind: "INVITATION" | "ALLOWLIST";
      invitation_exchange_session_id: string | null;
    }>,
  ) => {
    if (!input.emailOtp) return false;
    const invitation =
      ticket.authorization_kind === "INVITATION"
        ? activeInvitationExchange(ticket.invitation_exchange_session_id ?? undefined)
        : null;
    const authorization = input.emailOtp.registrationPolicy.authorize({
      email: ticket.normalized_email,
      ...(invitation ? { invitationActive: true } : {}),
    });
    return (
      authorization.ok &&
      authorization.value.allowed &&
      authorization.value.authorizationKind === ticket.authorization_kind
    );
  };

  const finalizeEmailMember = (userId: string): boolean => {
    const ticket = input.database
      .query<
        {
          id: string;
          normalized_email: string;
          intended_member_id: string;
          display_name: string;
          authorization_kind: "INVITATION" | "ALLOWLIST";
          invitation_exchange_session_id: string | null;
        },
        [string, number]
      >(
        `SELECT id, normalized_email, intended_member_id, display_name,
                authorization_kind, invitation_exchange_session_id
         FROM auth_email_registration_tickets
         WHERE auth_user_id = ? AND state = 'AUTHORIZED'
           AND consumed_at IS NULL AND expires_at > ?`,
      )
      .get(userId, now());
    if (!ticket || !authorizeEmailTicket(ticket)) return false;
    try {
      inImmediateTransaction(input.database, () => {
        if (!authorizeEmailTicket(ticket)) throw new Error("EMAIL_AUTHORIZATION_EXPIRED");
        if (ticket.authorization_kind === "INVITATION") {
          const invitation = activeInvitationExchange(
            ticket.invitation_exchange_session_id ?? undefined,
          );
          if (!invitation) throw new Error("EMAIL_AUTHORIZATION_EXPIRED");
          const consumedExchange = input.database
            .query(
              `UPDATE invitation_exchange_sessions
               SET consumed_at = ?, revision = revision + 1
               WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
            )
            .run(now(), invitation.exchange_id, now());
          const consumedInvitation = input.database
            .query(
              `UPDATE invitations SET consumed_at = ?, revision = revision + 1
               WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
            )
            .run(now(), invitation.invitation_id, now());
          if (consumedExchange.changes !== 1 || consumedInvitation.changes !== 1)
            throw new Error("EMAIL_AUTHORIZATION_EXPIRED");
        }
        const consumedTicket = input.database
          .query(
            `UPDATE auth_email_registration_tickets
             SET state = 'CONSUMED', consumed_at = ?
             WHERE id = ? AND state = 'AUTHORIZED' AND consumed_at IS NULL AND expires_at > ?`,
          )
          .run(now(), ticket.id, now());
        if (consumedTicket.changes !== 1) throw new Error("EMAIL_TICKET_CONSUMED");
        input.database
          .query(
            `INSERT INTO members(
               id, display_name, role, status, authority_epoch, revision, created_at
             ) VALUES (?, ?, 'MEMBER', 'ACTIVE', 1, 1, ?)`,
          )
          .run(ticket.intended_member_id, ticket.display_name, now());
        input.database
          .query(
            `INSERT INTO auth_member_links(
               auth_user_id, member_id, authority_epoch_snapshot, created_at
             ) VALUES (?, ?, 1, ?)`,
          )
          .run(userId, ticket.intended_member_id, now());
      });
      audit({
        kind: "EMAIL_OTP_REGISTRATION_COMPLETED",
        actorKind: "SYSTEM",
        actorId: "BETTER_AUTH",
        subjectId: ticket.intended_member_id,
        safeDetails: {
          authorizationKind: ticket.authorization_kind,
          role: "MEMBER",
        },
      });
      return true;
    } catch {
      return false;
    }
  };

  const auth = betterAuth({
    appName: input.rpName,
    database: input.database,
    baseURL: input.publicBaseUrl,
    basePath: "/api/auth",
    secret: input.secret,
    trustedOrigins: [input.publicBaseUrl],
    emailAndPassword: { enabled: false },
    account: {
      modelName: "auth_accounts",
      accountLinking: { enabled: false },
    },
    user: { modelName: "auth_users" },
    verification: { modelName: "auth_verifications" },
    session: {
      modelName: "auth_sessions",
      expiresIn: BROWSER_ABSOLUTE_SECONDS,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        purpose: {
          type: "string",
          required: true,
          defaultValue: "BROWSER",
          input: false,
        },
        memberAuthorityEpoch: {
          type: "number",
          required: true,
          defaultValue: 0,
          input: false,
        },
        absoluteExpiresAt: { type: "date", required: true, input: false },
      },
    },
    advanced: {
      useSecureCookies: new URL(input.publicBaseUrl).protocol === "https:",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "strict",
        secure: new URL(input.publicBaseUrl).protocol === "https:",
        path: "/",
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!user.email.endsWith("@identity.invalid")) return false;
            return { data: { ...user, emailVerified: false } };
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            let member = linkedMember(session.userId);
            if (!member && context?.path === "/sign-in/email-otp") {
              finalizeEmailMember(session.userId);
              member = linkedMember(session.userId);
            }
            if (!member || member.authority_epoch !== member.snapshot) return false;
            const purpose: SessionPurpose =
              context?.path === "/device/token" ? "CLI_DEVICE" : "BROWSER";
            const lifetime =
              purpose === "CLI_DEVICE" ? CLI_DEVICE_SECONDS : BROWSER_ABSOLUTE_SECONDS;
            const absoluteExpiresAt = new Date((now() + lifetime) * 1_000);
            return {
              data: {
                ...session,
                expiresAt: absoluteExpiresAt,
                purpose,
                memberAuthorityEpoch: member.authority_epoch,
                absoluteExpiresAt,
              },
            };
          },
          after: async (session) => {
            const member = linkedMember(session.userId);
            if (!member) return;
            const purpose = (session as unknown as AuthSession).purpose;
            audit({
              kind: "AUTH_SESSION_ISSUED",
              actorKind: "MEMBER",
              actorId: member.member_id,
              subjectId: session.id,
              safeDetails: {
                purpose,
                ttlSeconds:
                  purpose === "CLI_DEVICE" ? CLI_DEVICE_SECONDS : BROWSER_ABSOLUTE_SECONDS,
              },
            });
          },
        },
      },
    },
    plugins: [
      passkey({
        rpID: input.rpId,
        rpName: input.rpName,
        origin: input.publicBaseUrl,
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        registration: {
          requireSession: false,
          resolveUser: async ({ context }) => {
            if (!context || context.length < 32 || context.length > 512)
              throw new Error("AUTH_REGISTRATION_CONTEXT_INVALID");
            const ticket = input.database
              .query<
                {
                  id: string;
                  auth_user_id: string;
                  intended_member_id: string;
                  display_name: string;
                  purpose: string;
                },
                [Uint8Array, number]
              >(
                `SELECT id, auth_user_id, intended_member_id, display_name, purpose
                 FROM auth_registration_tickets
                 WHERE secret_hash = ? AND expires_at > ?
                   AND (
                     state = 'PENDING' OR (
                       state = 'PASSKEY_VERIFIED' AND NOT EXISTS(
                         SELECT 1 FROM auth_passkeys
                         WHERE userId = auth_registration_tickets.auth_user_id
                           AND createdAt >= auth_registration_tickets.created_at * 1000
                       )
                     )
                   )`,
              )
              .get(sha256(context), now());
            if (!ticket) throw new Error("AUTH_REGISTRATION_CONTEXT_INVALID");
            return {
              id: ticket.auth_user_id,
              name: ticket.auth_user_id,
              displayName: ticket.display_name,
            };
          },
          afterVerification: async ({ verification, context }) => {
            if (!verification.registrationInfo?.userVerified)
              throw new Error("PASSKEY_USER_VERIFICATION_REQUIRED");
            if (!context) throw new Error("AUTH_REGISTRATION_CONTEXT_INVALID");
            const ticket = input.database
              .query<
                {
                  id: string;
                  intended_member_id: string;
                  purpose: string;
                  invitation_id: string | null;
                },
                [Uint8Array, number]
              >(
                `SELECT tickets.id, tickets.intended_member_id, tickets.purpose,
                        invitations.id AS invitation_id
                 FROM auth_registration_tickets AS tickets
                 LEFT JOIN invitation_exchange_sessions AS exchange
                   ON exchange.id = tickets.invitation_exchange_session_id
                 LEFT JOIN invitations ON invitations.id = exchange.invitation_id
                 WHERE tickets.secret_hash = ? AND tickets.expires_at > ?
                   AND (
                     tickets.state = 'PENDING' OR (
                       tickets.state = 'PASSKEY_VERIFIED' AND NOT EXISTS(
                         SELECT 1 FROM auth_passkeys
                         WHERE userId = tickets.auth_user_id
                           AND createdAt >= tickets.created_at * 1000
                       )
                     )
                   )`,
              )
              .get(sha256(context), now());
            if (!ticket) throw new Error("AUTH_REGISTRATION_CONTEXT_INVALID");
            const changed = input.database
              .query(
                `UPDATE auth_registration_tickets SET state = 'PASSKEY_VERIFIED'
                 WHERE id = ? AND expires_at > ?
                   AND (
                     state = 'PENDING' OR (
                       state = 'PASSKEY_VERIFIED' AND NOT EXISTS(
                         SELECT 1 FROM auth_passkeys
                         WHERE userId = auth_registration_tickets.auth_user_id
                           AND createdAt >= auth_registration_tickets.created_at * 1000
                       )
                     )
                   )`,
              )
              .run(ticket.id, now());
            if (changed.changes !== 1) throw new Error("AUTH_REGISTRATION_CONTEXT_INVALID");
            audit({
              kind:
                ticket.purpose === "INVITATION"
                  ? "INVITATION_PASSKEY_VERIFIED"
                  : "PASSKEY_VERIFIED",
              actorKind: ticket.invitation_id ? "INVITATION" : "SYSTEM",
              actorId: ticket.invitation_id ?? "BETTER_AUTH",
              subjectId: ticket.intended_member_id,
              safeDetails: {
                ceremony: "REGISTRATION",
                purpose: ticket.purpose,
                userVerified: true,
              },
            });
          },
        },
        authentication: {
          afterVerification: async ({ verification, clientData }) => {
            if (!verification.authenticationInfo.userVerified)
              throw new Error("PASSKEY_USER_VERIFICATION_REQUIRED");
            const passkey = input.database
              .query<{ id: string; userId: string }, [string]>(
                "SELECT id, userId FROM auth_passkeys WHERE credentialID = ?",
              )
              .get(clientData.id);
            const member = passkey ? linkedMember(passkey.userId) : null;
            if (passkey && member)
              audit({
                kind: "PASSKEY_VERIFIED",
                actorKind: "MEMBER",
                actorId: member.member_id,
                subjectId: passkey.id,
                safeDetails: { ceremony: "AUTHENTICATION", userVerified: true },
              });
          },
        },
        schema: { passkey: { modelName: "auth_passkeys" } },
      }),
      deviceAuthorization({
        expiresIn: "10m",
        interval: "5s",
        verificationUri: "/device",
        validateClient: async (clientId) => clientId === COLLAB_CLI_CLIENT_ID,
        onDeviceAuthRequest: async (_clientId, scope) => {
          if (scope !== COLLAB_CLI_SCOPE) throw new Error("DEVICE_SCOPE_INVALID");
        },
        schema: { deviceCode: { modelName: "auth_device_codes" } },
      }),
      ...(input.emailOtp
        ? [
            emailOTP({
              disableSignUp: true,
              storeOTP: "hashed",
              otpLength: 6,
              expiresIn: 300,
              allowedAttempts: 3,
              resendStrategy: "rotate",
              rateLimit: { window: 60, max: EMAIL_OTP_SENDS_PER_MINUTE },
              changeEmail: { enabled: true, verifyCurrentEmail: false },
              sendVerificationOTP: async ({ email, otp, type }) => {
                if (type !== "sign-in" && type !== "change-email")
                  throw new Error("EMAIL_OTP_TYPE_DISABLED");
                queueEmailDelivery(email, otp);
              },
            }),
          ]
        : []),
      bearer(),
    ],
  });

  async function sessionFrom(request: Request): Promise<LinkedSession | null> {
    const value = await auth.api.getSession({ headers: request.headers });
    if (!value) return null;
    const session = value.session as unknown as AuthSession;
    const member = linkedMember(session.userId);
    const current = now();
    if (
      !member ||
      member.authority_epoch !== member.snapshot ||
      member.authority_epoch !== session.memberAuthorityEpoch ||
      current >= Math.floor(new Date(session.expiresAt).getTime() / 1_000) ||
      current >= Math.floor(new Date(session.absoluteExpiresAt).getTime() / 1_000)
    )
      return null;
    if (
      session.purpose === "BROWSER" &&
      current - Math.floor(new Date(session.updatedAt).getTime() / 1_000) >= BROWSER_IDLE_SECONDS
    )
      return null;
    input.database
      .query("UPDATE auth_sessions SET updatedAt = ? WHERE id = ?")
      .run(current * 1_000, session.id);
    return {
      session,
      memberId: member.member_id,
      memberAuthorityEpoch: member.authority_epoch,
    };
  }

  const authentication: CollabAuthenticationPort = {
    async authenticateBrowser(request) {
      if (request.headers.has("authorization")) {
        auditAuthenticationFailure("BROWSER", "MIXED_MODE");
        return failure(
          "AUTH_MODE_CONFLICT",
          "Browser and device authentication cannot be combined.",
        );
      }
      const linked = await sessionFrom(request);
      if (linked?.session.purpose !== "BROWSER") {
        auditAuthenticationFailure("BROWSER", "SESSION_REJECTED");
        return failure("SESSION_REQUIRED", "Member session is required.");
      }
      return {
        ok: true,
        value: {
          kind: "MEMBER",
          memberId: linked.memberId as never,
          sessionId: linked.session.id as never,
          sessionProof: createHash("sha256").update(linked.session.token).digest("base64url"),
        },
      };
    },
    async authenticateDevice(request) {
      if (request.headers.has("cookie")) {
        auditAuthenticationFailure("CLI_DEVICE", "MIXED_MODE");
        return failure(
          "AUTH_MODE_CONFLICT",
          "Browser and device authentication cannot be combined.",
        );
      }
      const linked = await sessionFrom(request);
      if (linked?.session.purpose !== "CLI_DEVICE") {
        auditAuthenticationFailure("CLI_DEVICE", "SESSION_REJECTED");
        return failure("DEVICE_AUTHENTICATION_REQUIRED", "Device authentication is required.");
      }
      return {
        ok: true,
        value: {
          kind: "MEMBER",
          memberId: linked.memberId as never,
          sessionId: linked.session.id as never,
          sessionProof: createHash("sha256").update(linked.session.token).digest("base64url"),
        },
      };
    },
    async authenticateRunnerDevice(request) {
      if (request.headers.has("cookie")) {
        auditAuthenticationFailure("RUNNER_PAIRING", "MIXED_MODE");
        return failure(
          "AUTH_MODE_CONFLICT",
          "Browser and device authentication cannot be combined.",
        );
      }
      const linked = await sessionFrom(request);
      if (linked?.session.purpose !== "CLI_DEVICE") {
        auditAuthenticationFailure("RUNNER_PAIRING", "SESSION_REJECTED");
        return failure("DEVICE_AUTHENTICATION_REQUIRED", "Device authentication is required.");
      }
      return {
        ok: true,
        value: {
          kind: "VERIFIED_DEVICE",
          memberId: linked.memberId as never,
          memberAuthorityEpoch: linked.memberAuthorityEpoch,
          deviceFamilyId: linked.session.id,
          deviceId: linked.session.userId,
          senderKeyThumbprint: "better_auth_bearer",
          expiresAt: Math.floor(new Date(linked.session.expiresAt).getTime() / 1_000),
        } as unknown as VerifiedDevicePrincipal,
      };
    },
    verifyBrowserMutation(request, _actor) {
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
      return (
        !request.headers.has("authorization") &&
        request.headers.get("origin") === input.publicBaseUrl &&
        request.headers.get("sec-fetch-site") === "same-origin" &&
        mediaType === "application/json" &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method.toUpperCase())
      );
    },
  };

  async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/device/code")
      input.database.query("DELETE FROM auth_device_codes WHERE expiresAt <= ?").run(now() * 1_000);
    if (
      path === "/api/auth/passkey/generate-authenticate-options" ||
      path === "/api/auth/passkey/generate-register-options"
    )
      input.database
        .query("DELETE FROM auth_verifications WHERE expiresAt <= ?")
        .run(now() * 1_000);
    if (path === "/api/auth/device/code" && request.method === "POST") {
      let body: unknown;
      try {
        body = await request.clone().json();
      } catch {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      if (
        typeof body !== "object" ||
        body === null ||
        !("client_id" in body) ||
        "user_id" in body ||
        (body as Record<string, unknown>).scope !== COLLAB_CLI_SCOPE
      )
        return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const response = await auth.handler(request);
    if (response.status >= 400 && path === "/api/auth/passkey/verify-authentication") {
      auditAuthenticationFailure("PASSKEY", "ENDPOINT_REJECTED");
    }
    if (response.status >= 400 && path === "/api/auth/device/token") {
      let error: unknown;
      try {
        error = ((await response.clone().json()) as { error?: unknown }).error;
      } catch {
        error = undefined;
      }
      if (error !== "authorization_pending" && error !== "slow_down")
        auditAuthenticationFailure("DEVICE_EXCHANGE", "ENDPOINT_REJECTED");
    }
    return response;
  }

  const requestEmailOtp: CollabEmailOtpPort["request"] = async (command) => {
    if (!input.emailOtp) return;
    const normalized = normalizeRegistrationEmail(command.email);
    if (!normalized.ok) return;
    const email = normalized.value;
    const current = now();
    if (!reserveEmailSend(email)) return;

    input.database
      .query(
        `DELETE FROM auth_users
         WHERE id IN (
           SELECT auth_user_id FROM auth_email_registration_tickets
           WHERE state != 'CONSUMED' AND expires_at <= ?
         ) AND NOT EXISTS(
           SELECT 1 FROM auth_member_links WHERE auth_member_links.auth_user_id = auth_users.id
         )`,
      )
      .run(current);

    let user = input.database
      .query<{ id: string }, [string]>("SELECT id FROM auth_users WHERE email = ?")
      .get(email);
    if (user) {
      const anyLink = input.database
        .query<{ member_id: string; status: string; revoked_at: number | null }, [string]>(
          `SELECT links.member_id, members.status, links.revoked_at
           FROM auth_member_links AS links JOIN members ON members.id = links.member_id
           WHERE links.auth_user_id = ?`,
        )
        .get(user.id);
      if (anyLink) {
        if (anyLink.status !== "ACTIVE" || anyLink.revoked_at !== null) return;
      } else {
        const ticket = input.database
          .query<
            {
              normalized_email: string;
              authorization_kind: "INVITATION" | "ALLOWLIST";
              invitation_exchange_session_id: string | null;
            },
            [string, number]
          >(
            `SELECT normalized_email, authorization_kind, invitation_exchange_session_id
             FROM auth_email_registration_tickets
             WHERE auth_user_id = ? AND state = 'AUTHORIZED' AND expires_at > ?`,
          )
          .get(user.id, current);
        if (!ticket || !authorizeEmailTicket(ticket)) return;
        if (ticket.invitation_exchange_session_id !== (command.invitationExchangeSessionId ?? null))
          return;
      }
    } else {
      const invitation = activeInvitationExchange(command.invitationExchangeSessionId);
      const authorization = input.emailOtp.registrationPolicy.authorize({
        email,
        ...(invitation ? { invitationActive: true } : {}),
      });
      const displayName = command.displayName?.trim();
      if (
        !authorization.ok ||
        !authorization.value.allowed ||
        !displayName ||
        displayName.length > 120
      )
        return;
      const authorizationKind = authorization.value.authorizationKind;
      if (!authorizationKind) return;
      const authUserId = id("auth_user");
      const memberId = id("member");
      const ticketId = id("email_registration");
      try {
        inImmediateTransaction(input.database, () => {
          input.database
            .query(
              `INSERT INTO auth_users(id, name, email, emailVerified, createdAt, updatedAt)
               VALUES (?, ?, ?, 0, ?, ?)`,
            )
            .run(authUserId, displayName, email, current * 1_000, current * 1_000);
          input.database
            .query(
              `INSERT INTO auth_email_registration_tickets(
                 id, secret_hash, normalized_email, auth_user_id, intended_member_id,
                 invitation_exchange_session_id, display_name, authorization_kind,
                 policy_revision, state, created_at, expires_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUTHORIZED', ?, ?)`,
            )
            .run(
              ticketId,
              createHash("sha256").update(randomBytes(32)).digest(),
              email,
              authUserId,
              memberId,
              invitation?.exchange_id ?? null,
              displayName,
              authorizationKind,
              authorization.value.policyRevision,
              current,
              current + EMAIL_OTP_TICKET_SECONDS,
            );
        });
        user = { id: authUserId };
      } catch {
        return;
      }
    }
    if (!user) return;
    try {
      await withEmailSendLock(email, () =>
        auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } }),
      );
      audit({
        kind: "EMAIL_OTP_REQUEST_ACCEPTED",
        actorKind: "SYSTEM",
        actorId: "AUTH_BOUNDARY",
        safeDetails: { returning: linkedMember(user.id) !== null },
      });
    } catch {
      auditAuthenticationFailure("EMAIL_OTP", "ENDPOINT_REJECTED");
    }
  };

  const verifyEmailOtp: CollabEmailOtpPort["verify"] = async (command) => {
    if (!input.emailOtp || !/^\d{6}$/.test(command.otp))
      return failure("EMAIL_OTP_INVALID", "Email verification is invalid or expired.");
    const normalized = normalizeRegistrationEmail(command.email);
    if (!normalized.ok)
      return failure("EMAIL_OTP_INVALID", "Email verification is invalid or expired.");
    const user = input.database
      .query<{ id: string }, [string]>("SELECT id FROM auth_users WHERE email = ?")
      .get(normalized.value);
    if (!user) return failure("EMAIL_OTP_INVALID", "Email verification is invalid or expired.");
    const member = linkedMember(user.id);
    if (!member) {
      const ticket = input.database
        .query<
          {
            normalized_email: string;
            authorization_kind: "INVITATION" | "ALLOWLIST";
            invitation_exchange_session_id: string | null;
          },
          [string, number]
        >(
          `SELECT normalized_email, authorization_kind, invitation_exchange_session_id
           FROM auth_email_registration_tickets
           WHERE auth_user_id = ? AND state = 'AUTHORIZED' AND expires_at > ?`,
        )
        .get(user.id, now());
      if (
        !ticket ||
        !authorizeEmailTicket(ticket) ||
        ticket.invitation_exchange_session_id !== (command.invitationExchangeSessionId ?? null)
      )
        return failure("EMAIL_OTP_INVALID", "Email verification is invalid or expired.");
    }
    try {
      const result = await withEmailSendLock(normalized.value, () =>
        auth.api.signInEmailOTP({
          body: { email: normalized.value, otp: command.otp },
          returnHeaders: true,
        }),
      );
      const linked = linkedMember(result.response.user.id);
      if (!linked) throw new Error("EMAIL_MEMBER_LINK_REQUIRED");
      return {
        ok: true,
        value: { memberId: linked.member_id, headers: result.headers },
      };
    } catch {
      auditAuthenticationFailure("EMAIL_OTP", "ENDPOINT_REJECTED");
      return failure("EMAIL_OTP_INVALID", "Email verification is invalid or expired.");
    }
  };

  const enrollEmailOtp: CollabEmailOtpPort["enrollRequest"] = async (command) => {
    if (!input.emailOtp)
      return failure("EMAIL_OTP_DISABLED", "Email authentication is unavailable.");
    const linked = await sessionFrom(command.request);
    const normalized = normalizeRegistrationEmail(command.email);
    if (linked?.session.purpose !== "BROWSER" || !normalized.ok)
      return failure("SESSION_REQUIRED", "Member session is required.");
    const currentUser = input.database
      .query<{ email: string }, [string]>("SELECT email FROM auth_users WHERE id = ?")
      .get(linked.session.userId);
    const collision = input.database
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM auth_users WHERE email = ? AND id != ?",
      )
      .get(normalized.value, linked.session.userId);
    if (
      !currentUser ||
      collision ||
      currentUser.email === normalized.value ||
      !reserveEmailSend(normalized.value)
    )
      return { ok: true, value: { accepted: true } };
    try {
      await withEmailSendLock(normalized.value, () =>
        auth.api.requestEmailChangeEmailOTP({
          headers: command.request.headers,
          body: { newEmail: normalized.value },
        }),
      );
      return { ok: true, value: { accepted: true } };
    } catch {
      auditAuthenticationFailure("EMAIL_OTP", "ENDPOINT_REJECTED");
      return { ok: true, value: { accepted: true } };
    }
  };

  const verifyEnrollmentEmailOtp: CollabEmailOtpPort["enrollVerify"] = async (command) => {
    if (!input.emailOtp || !/^\d{6}$/.test(command.otp))
      return failure("EMAIL_OTP_INVALID", "Email verification is invalid or expired.");
    const linked = await sessionFrom(command.request);
    const normalized = normalizeRegistrationEmail(command.email);
    if (linked?.session.purpose !== "BROWSER" || !normalized.ok)
      return failure("EMAIL_OTP_INVALID", "Email verification is invalid or expired.");
    try {
      const result = await withEmailSendLock(normalized.value, () =>
        auth.api.changeEmailEmailOTP({
          headers: command.request.headers,
          body: { newEmail: normalized.value, otp: command.otp },
          returnHeaders: true,
        }),
      );
      const after = linkedMember(linked.session.userId);
      if (!after || after.member_id !== linked.memberId)
        throw new Error("EMAIL_MEMBER_LINK_CHANGED");
      audit({
        kind: "EMAIL_OTP_ENROLLED",
        actorKind: "MEMBER",
        actorId: linked.memberId,
        subjectId: linked.session.userId,
        safeDetails: { verified: true },
      });
      return {
        ok: true,
        value: { memberId: linked.memberId, headers: result.headers },
      };
    } catch {
      auditAuthenticationFailure("EMAIL_OTP", "ENDPOINT_REJECTED");
      return failure("EMAIL_OTP_INVALID", "Email verification is invalid or expired.");
    }
  };

  return {
    auth,
    authentication,
    handle,
    safeEqual,
    ...(input.emailOtp
      ? {
          emailOtp: {
            request: requestEmailOtp,
            verify: verifyEmailOtp,
            enrollRequest: enrollEmailOtp,
            enrollVerify: verifyEnrollmentEmailOtp,
          },
        }
      : {}),
  };
}

export type CollabBetterAuth = ReturnType<typeof createCollabBetterAuth>;
