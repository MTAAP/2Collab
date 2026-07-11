import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";

const DEVICE_CODE_SECONDS = 10 * 60;
const ACCESS_SECONDS = 10 * 60;
const REFRESH_IDLE_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_ABSOLUTE_SECONDS = 90 * 24 * 60 * 60;

function error(
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" | "SAME_INPUT" = "NEVER",
): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

function sha256(value: string): Promise<Uint8Array> {
  return Promise.resolve(createHash("sha256").update(value, "utf8").digest());
}

function defaultSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  randomSecret?: (prefix: string) => string;
  digest?: (value: string) => Promise<Uint8Array>;
}>;

export type DeviceAccess = Readonly<{
  kind: "VERIFIED_DEVICE";
  memberId: string;
  memberAuthorityEpoch: number;
  deviceFamilyId: string;
  deviceId: string;
  senderKeyThumbprint: string;
  expiresAt: number;
}> &
  import("../../../shared/contracts/actors.ts").VerifiedDevicePrincipal;

type CodeRow = Readonly<{
  id: string;
  device_code_hash: Uint8Array;
  device_id: string;
  sender_key_thumbprint: string;
  member_id: string | null;
  state: "PENDING" | "APPROVED" | "CONSUMED" | "DENIED" | "EXPIRED";
  revision: number;
  expires_at: number;
}>;

type FamilyRow = Readonly<{
  id: string;
  member_id: string;
  device_id: string;
  sender_key_thumbprint: string;
  current_refresh_hash: Uint8Array;
  previous_refresh_hash: Uint8Array | null;
  member_authority_epoch: number;
  revision: number;
  idle_expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
}>;

export function createDeviceAuthority(dependencies: Dependencies) {
  const digest = dependencies.digest ?? sha256;
  const randomSecret = dependencies.randomSecret ?? defaultSecret;
  const idempotencyHash = (operation: string, value: unknown) =>
    createHash("sha256")
      .update(`${operation}:${JSON.stringify(value)}`, "utf8")
      .digest("hex");
  const replay = (actorId: string, key: string, hash: string): Result<never> | null => {
    const row = dependencies.database
      .query<{ input_hash: string; result_json: string }, [string, string]>(
        "SELECT input_hash, result_json FROM idempotency_results WHERE actor_id = ? AND idempotency_key = ?",
      )
      .get(actorId, key);
    if (!row) return null;
    return row.input_hash === hash
      ? error("SECRET_ALREADY_ISSUED", "Device credential was already issued.")
      : error("IDEMPOTENCY_CONFLICT", "Idempotency key was used with different input.");
  };
  const storeMarker = (actorId: string, key: string, hash: string) => {
    dependencies.database
      .query(
        "INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(actorId, key, hash, JSON.stringify({ kind: "SECRET_ISSUED" }), dependencies.clock());
  };

  const activeActor = async (actor: MemberActor) => {
    if (actor.sessionProof.length < 32 || actor.sessionProof.length > 512) return null;
    const proofHash = await digest(actor.sessionProof);
    return dependencies.database
      .query<
        { member_revision: number; session_revision: number; authority_epoch: number },
        [string, string, Uint8Array, number]
      >(
        `SELECT members.revision AS member_revision, sessions.revision AS session_revision,
                members.authority_epoch
         FROM members JOIN sessions ON sessions.member_id = members.id
         WHERE members.id = ? AND sessions.id = ? AND sessions.proof_hash = ?
           AND members.status = 'ACTIVE' AND sessions.kind = 'BROWSER'
           AND sessions.revoked_at IS NULL AND sessions.expires_at > ?
           AND sessions.member_authority_epoch = members.authority_epoch`,
      )
      .get(actor.memberId, actor.sessionId, proofHash, dependencies.clock());
  };

  const familyForHash = (
    hash: Uint8Array,
  ): (FamilyRow & { match_kind: "CURRENT" | "PREVIOUS" }) | null => {
    const current = dependencies.database
      .query<FamilyRow, [Uint8Array]>(
        "SELECT * FROM device_credential_families WHERE current_refresh_hash = ?",
      )
      .get(hash);
    if (current) return { ...current, match_kind: "CURRENT" };
    const previous = dependencies.database
      .query<FamilyRow, [Uint8Array]>(
        "SELECT * FROM device_credential_families WHERE previous_refresh_hash = ?",
      )
      .get(hash);
    return previous ? { ...previous, match_kind: "PREVIOUS" } : null;
  };

  return {
    async begin(
      input: Readonly<{ idempotencyKey: string; deviceId: string; senderKeyThumbprint: string }>,
    ): Promise<Result<Readonly<{ deviceCodeId: string; deviceCode: string; expiresAt: number }>>> {
      if (
        !validId(input.idempotencyKey) ||
        !validId(input.deviceId) ||
        !validId(input.senderKeyThumbprint)
      )
        return error("DEVICE_INPUT_INVALID", "Device authorization input is invalid.");
      const actorId = `DEVICE_BEGIN_${input.deviceId}`;
      const ticketHash = idempotencyHash("DEVICE_BEGIN", input);
      const prior = replay(actorId, input.idempotencyKey, ticketHash);
      if (prior) return prior;
      const deviceCode = randomSecret("device_code");
      const deviceCodeHash = await digest(deviceCode);
      const id = dependencies.id("device_code");
      const now = dependencies.clock();
      try {
        return inImmediateTransaction(dependencies.database, () => {
          dependencies.database
            .query(
              `INSERT INTO device_authorization_codes(
                 id, device_code_hash, device_id, sender_key_thumbprint, state,
                 revision, created_at, expires_at
               ) VALUES (?, ?, ?, ?, 'PENDING', 1, ?, ?)`,
            )
            .run(
              id,
              deviceCodeHash,
              input.deviceId,
              input.senderKeyThumbprint,
              now,
              now + DEVICE_CODE_SECONDS,
            );
          storeMarker(actorId, input.idempotencyKey, ticketHash);
          return {
            ok: true,
            value: { deviceCodeId: id, deviceCode, expiresAt: now + DEVICE_CODE_SECONDS },
          };
        });
      } catch {
        return error("DEVICE_OPERATION_FAILED", "Device authorization failed.");
      }
    },

    async approve(
      input: Readonly<{ idempotencyKey: string; actor: MemberActor; deviceCodeId: string }>,
    ): Promise<Result<Readonly<{ approved: true }>>> {
      if (!validId(input.idempotencyKey) || !validId(input.deviceCodeId))
        return error("DEVICE_INPUT_INVALID", "Device authorization input is invalid.");
      const authority = await activeActor(input.actor);
      if (!authority) return error("SESSION_INVALID", "Member session is invalid.");
      const snapshot = dependencies.database
        .query<CodeRow, [string]>("SELECT * FROM device_authorization_codes WHERE id = ?")
        .get(input.deviceCodeId);
      if (snapshot?.state !== "PENDING" || dependencies.clock() >= snapshot.expires_at)
        return error("DEVICE_CODE_INVALID", "Device authorization code is invalid.");
      const actorId = `DEVICE_APPROVE_${input.actor.memberId}`;
      const ticketHash = idempotencyHash("DEVICE_APPROVE", {
        memberId: input.actor.memberId,
        deviceCodeId: input.deviceCodeId,
      });
      const prior = replay(actorId, input.idempotencyKey, ticketHash);
      if (prior) return prior;
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const currentActor = dependencies.database
            .query<{ id: string }, [string, number, string, number]>(
              `SELECT members.id FROM members JOIN sessions ON sessions.member_id = members.id
               WHERE members.id = ? AND members.revision = ? AND members.status = 'ACTIVE'
                 AND sessions.id = ? AND sessions.revision = ? AND sessions.revoked_at IS NULL`,
            )
            .get(
              input.actor.memberId,
              authority.member_revision,
              input.actor.sessionId,
              authority.session_revision,
            );
          if (!currentActor)
            return error("AUTHORITY_STALE", "Identity authority changed.", "REFRESH");
          const changed = dependencies.database
            .query(
              `UPDATE device_authorization_codes SET member_id = ?, state = 'APPROVED', revision = revision + 1
               WHERE id = ? AND revision = ? AND state = 'PENDING' AND expires_at > ?`,
            )
            .run(input.actor.memberId, input.deviceCodeId, snapshot.revision, dependencies.clock());
          if (changed.changes === 1) storeMarker(actorId, input.idempotencyKey, ticketHash);
          return changed.changes === 1
            ? { ok: true, value: { approved: true as const } }
            : error("DEVICE_CODE_INVALID", "Device authorization code is invalid.");
        });
      } catch {
        return error("DEVICE_OPERATION_FAILED", "Device authorization failed.");
      }
    },

    async exchange(
      input: Readonly<{ idempotencyKey: string; deviceCode: string; senderKeyThumbprint: string }>,
    ): Promise<
      Result<
        Readonly<{
          accessToken: string;
          refreshCredential: string;
          accessExpiresAt: number;
          refreshIdleExpiresAt: number;
          refreshAbsoluteExpiresAt: number;
        }>
      >
    > {
      if (
        !validId(input.idempotencyKey) ||
        input.deviceCode.length < 32 ||
        input.deviceCode.length > 512 ||
        !validId(input.senderKeyThumbprint)
      )
        return error("DEVICE_CODE_INVALID", "Device authorization code is invalid.");
      const codeHash = await digest(input.deviceCode);
      const code = dependencies.database
        .query<CodeRow, [Uint8Array]>(
          "SELECT * FROM device_authorization_codes WHERE device_code_hash = ?",
        )
        .get(codeHash);
      if (!code) return error("DEVICE_CODE_INVALID", "Device authorization code is invalid.");
      const actorId = `DEVICE_EXCHANGE_${code.id}`;
      const ticketHash = idempotencyHash("DEVICE_EXCHANGE", {
        deviceCodeId: code.id,
        senderKeyThumbprint: input.senderKeyThumbprint,
      });
      const prior = replay(actorId, input.idempotencyKey, ticketHash);
      if (prior) return prior;
      if (
        code.state !== "APPROVED" ||
        !code.member_id ||
        code.sender_key_thumbprint !== input.senderKeyThumbprint ||
        dependencies.clock() >= code.expires_at
      )
        return error("DEVICE_CODE_INVALID", "Device authorization code is invalid.");
      const member = dependencies.database
        .query<{ authority_epoch: number; revision: number }, [string]>(
          "SELECT authority_epoch, revision FROM members WHERE id = ? AND status = 'ACTIVE'",
        )
        .get(code.member_id);
      if (!member) return error("DEVICE_CODE_INVALID", "Device authorization code is invalid.");
      const accessToken = randomSecret("device_access");
      const refreshCredential = randomSecret("device_refresh");
      const [accessHash, refreshHash] = await Promise.all([
        digest(accessToken),
        digest(refreshCredential),
      ]);
      const familyId = dependencies.id("device_family");
      const accessId = dependencies.id("device_access");
      const now = dependencies.clock();
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const changed = dependencies.database
            .query(
              `UPDATE device_authorization_codes SET state = 'CONSUMED', consumed_at = ?, revision = revision + 1
               WHERE id = ? AND revision = ? AND state = 'APPROVED' AND expires_at > ?`,
            )
            .run(now, code.id, code.revision, now);
          const currentMember = dependencies.database
            .query<{ id: string }, [string, number, number]>(
              "SELECT id FROM members WHERE id = ? AND status = 'ACTIVE' AND revision = ? AND authority_epoch = ?",
            )
            .get(code.member_id as string, member.revision, member.authority_epoch);
          if (changed.changes !== 1 || !currentMember)
            return error("AUTHORITY_STALE", "Identity authority changed.", "REFRESH");
          dependencies.database
            .query(
              `INSERT INTO device_credential_families(
                 id, member_id, device_id, sender_key_thumbprint, current_refresh_hash,
                 member_authority_epoch, revision, created_at, idle_expires_at, absolute_expires_at
               ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            )
            .run(
              familyId,
              code.member_id,
              code.device_id,
              code.sender_key_thumbprint,
              refreshHash,
              member.authority_epoch,
              now,
              now + REFRESH_IDLE_SECONDS,
              now + REFRESH_ABSOLUTE_SECONDS,
            );
          dependencies.database
            .query(
              `INSERT INTO device_access_tokens(
                 id, family_id, access_hash, sender_key_thumbprint, revision, created_at, expires_at
               ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              accessId,
              familyId,
              accessHash,
              code.sender_key_thumbprint,
              now,
              now + ACCESS_SECONDS,
            );
          storeMarker(actorId, input.idempotencyKey, ticketHash);
          return {
            ok: true,
            value: {
              accessToken,
              refreshCredential,
              accessExpiresAt: now + ACCESS_SECONDS,
              refreshIdleExpiresAt: now + REFRESH_IDLE_SECONDS,
              refreshAbsoluteExpiresAt: now + REFRESH_ABSOLUTE_SECONDS,
            },
          };
        });
      } catch {
        return error("DEVICE_OPERATION_FAILED", "Device authorization failed.");
      }
    },

    async refresh(
      input: Readonly<{
        idempotencyKey: string;
        refreshCredential: string;
        senderKeyThumbprint: string;
      }>,
    ): Promise<
      Result<Readonly<{ accessToken: string; refreshCredential: string; accessExpiresAt: number }>>
    > {
      if (
        !validId(input.idempotencyKey) ||
        input.refreshCredential.length < 32 ||
        input.refreshCredential.length > 512 ||
        !validId(input.senderKeyThumbprint)
      )
        return error("DEVICE_REFRESH_INVALID", "Device refresh credential is invalid.");
      const refreshHash = await digest(input.refreshCredential);
      const family = familyForHash(refreshHash);
      if (!family || family.sender_key_thumbprint !== input.senderKeyThumbprint)
        return error("DEVICE_REFRESH_INVALID", "Device refresh credential is invalid.");
      const actorId = `DEVICE_REFRESH_${family.id}`;
      const ticketHash = idempotencyHash("DEVICE_REFRESH", {
        familyId: family.id,
        refreshHash: Buffer.from(refreshHash).toString("hex"),
        senderKeyThumbprint: input.senderKeyThumbprint,
      });
      const prior = replay(actorId, input.idempotencyKey, ticketHash);
      if (prior) return prior;
      if (family.match_kind === "PREVIOUS") {
        try {
          inImmediateTransaction(dependencies.database, () => {
            const now = dependencies.clock();
            dependencies.database
              .query(
                "UPDATE device_credential_families SET revoked_at = ?, revision = revision + 1 WHERE id = ? AND revoked_at IS NULL",
              )
              .run(now, family.id);
            dependencies.database
              .query(
                "UPDATE device_access_tokens SET revoked_at = ?, revision = revision + 1 WHERE family_id = ? AND revoked_at IS NULL",
              )
              .run(now, family.id);
          });
        } catch {
          return error("DEVICE_OPERATION_FAILED", "Device authorization failed.");
        }
        return error("DEVICE_REFRESH_REPLAY", "Device refresh credential was replayed.");
      }
      const now = dependencies.clock();
      if (
        family.revoked_at !== null ||
        now >= family.idle_expires_at ||
        now >= family.absolute_expires_at
      )
        return error("DEVICE_REFRESH_EXPIRED", "Device refresh credential expired.");
      const member = dependencies.database
        .query<{ authority_epoch: number; revision: number }, [string]>(
          "SELECT authority_epoch, revision FROM members WHERE id = ? AND status = 'ACTIVE'",
        )
        .get(family.member_id);
      if (!member || member.authority_epoch !== family.member_authority_epoch)
        return error("DEVICE_REFRESH_REVOKED", "Device refresh credential is revoked.");
      const accessToken = randomSecret("device_access");
      const nextRefresh = randomSecret("device_refresh");
      const [accessHash, nextRefreshHash] = await Promise.all([
        digest(accessToken),
        digest(nextRefresh),
      ]);
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const changed = dependencies.database
            .query(
              `UPDATE device_credential_families SET
                 previous_refresh_hash = current_refresh_hash, current_refresh_hash = ?,
                 revision = revision + 1, last_used_at = ?, idle_expires_at = ?
               WHERE id = ? AND revision = ? AND current_refresh_hash = ? AND revoked_at IS NULL
                 AND idle_expires_at > ? AND absolute_expires_at > ?`,
            )
            .run(
              nextRefreshHash,
              now,
              Math.min(family.absolute_expires_at, now + REFRESH_IDLE_SECONDS),
              family.id,
              family.revision,
              refreshHash,
              now,
              now,
            );
          const currentMember = dependencies.database
            .query<{ id: string }, [string, number, number]>(
              "SELECT id FROM members WHERE id = ? AND status = 'ACTIVE' AND revision = ? AND authority_epoch = ?",
            )
            .get(family.member_id, member.revision, member.authority_epoch);
          if (changed.changes !== 1 || !currentMember) {
            const replayed = dependencies.database
              .query<{ id: string }, [string, Uint8Array]>(
                "SELECT id FROM device_credential_families WHERE id = ? AND previous_refresh_hash = ? AND revoked_at IS NULL",
              )
              .get(family.id, refreshHash);
            if (replayed) {
              dependencies.database
                .query(
                  "UPDATE device_credential_families SET revoked_at = ?, revision = revision + 1 WHERE id = ? AND revoked_at IS NULL",
                )
                .run(now, family.id);
              dependencies.database
                .query(
                  "UPDATE device_access_tokens SET revoked_at = ?, revision = revision + 1 WHERE family_id = ? AND revoked_at IS NULL",
                )
                .run(now, family.id);
            }
            return error("DEVICE_REFRESH_REPLAY", "Device refresh credential was replayed.");
          }
          dependencies.database
            .query(
              `INSERT INTO device_access_tokens(
                 id, family_id, access_hash, sender_key_thumbprint, revision, created_at, expires_at
               ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              dependencies.id("device_access"),
              family.id,
              accessHash,
              family.sender_key_thumbprint,
              now,
              now + ACCESS_SECONDS,
            );
          storeMarker(actorId, input.idempotencyKey, ticketHash);
          return {
            ok: true,
            value: {
              accessToken,
              refreshCredential: nextRefresh,
              accessExpiresAt: now + ACCESS_SECONDS,
            },
          };
        });
      } catch {
        return error("DEVICE_OPERATION_FAILED", "Device authorization failed.");
      }
    },

    async verifyAccess(
      input: Readonly<{ accessToken: string; senderKeyThumbprint: string }>,
    ): Promise<Result<DeviceAccess>> {
      if (
        input.accessToken.length < 32 ||
        input.accessToken.length > 512 ||
        !validId(input.senderKeyThumbprint)
      )
        return error("DEVICE_ACCESS_INVALID", "Device access credential is invalid.");
      const accessHash = await digest(input.accessToken);
      const row = dependencies.database
        .query<
          Readonly<{
            member_id: string;
            member_authority_epoch: number;
            family_id: string;
            device_id: string;
            sender_key_thumbprint: string;
            expires_at: number;
          }>,
          [Uint8Array, string, number]
        >(
          `SELECT families.member_id, families.member_authority_epoch, families.id AS family_id,
                  families.device_id, tokens.sender_key_thumbprint, tokens.expires_at
           FROM device_access_tokens AS tokens
           JOIN device_credential_families AS families ON families.id = tokens.family_id
           JOIN members ON members.id = families.member_id
           WHERE tokens.access_hash = ? AND tokens.sender_key_thumbprint = ?
             AND tokens.revoked_at IS NULL AND tokens.expires_at > ?
             AND families.revoked_at IS NULL AND members.status = 'ACTIVE'
             AND families.member_authority_epoch = members.authority_epoch`,
        )
        .get(accessHash, input.senderKeyThumbprint, dependencies.clock());
      return row
        ? {
            ok: true,
            value: {
              kind: "VERIFIED_DEVICE",
              memberId: row.member_id,
              memberAuthorityEpoch: row.member_authority_epoch,
              deviceFamilyId: row.family_id,
              deviceId: row.device_id,
              senderKeyThumbprint: row.sender_key_thumbprint,
              expiresAt: row.expires_at,
            } as DeviceAccess,
          }
        : error("DEVICE_ACCESS_INVALID", "Device access credential is invalid.");
    },
  };
}
