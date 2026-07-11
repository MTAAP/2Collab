import type { Database } from "bun:sqlite";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { ApplyRevocation } from "../../../shared/contracts/commands.ts";
import type { MemberId } from "../../../shared/contracts/ids.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import {
  type BrowserSessionAuthorityFacts,
  createBrowserSessionAuthority,
} from "./browser-session-authority.ts";

export type RemoveMember = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  memberId: MemberId;
  expectedRevision: number;
}>;

export type MemberRemoval = Readonly<{
  memberId: MemberId;
  authorityEpoch: number;
  disposition: "REVOKED";
  revokedEpochs: readonly ["MEMBER", "RUNNER", "SESSION", "DEVICE"];
  revocationDispatch: "DISPATCHED" | "PENDING";
}>;

export interface RevocationExecutionAuthority {
  execute(command: ApplyRevocation): Promise<Result<Readonly<{ applied: true }>>>;
}

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  digest: (value: string) => Promise<Uint8Array>;
  executionAuthority: RevocationExecutionAuthority;
  outlineProviderRevocation?: Readonly<{
    revokeCredential(credentialId: string): Promise<Result<Readonly<{ revoked: true }>>>;
  }>;
}>;

function tableExists(database: Database, name: string): boolean {
  return (
    database
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(name) !== null
  );
}

function error(
  code: string,
  message: string,
  retry: "NEVER" | "SAME_INPUT" = "NEVER",
): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

type RemovalSnapshot = Readonly<{
  targetRevision: number;
  targetRole: "OWNER" | "MEMBER";
  targetAuthorityEpoch: number;
  actorAuthority: BrowserSessionAuthorityFacts;
}>;

function removeMemberTransaction(
  database: Database,
  command: RemoveMember,
  snapshot: RemovalSnapshot,
  dependencies: Pick<Dependencies, "clock" | "id"> & {
    browserSessions: ReturnType<typeof createBrowserSessionAuthority>;
  },
): Result<MemberRemoval> {
  return inImmediateTransaction(database, () => {
    const actor = dependencies.browserSessions.revalidate(snapshot.actorAuthority, {
      role: "OWNER",
    });
    const target = database
      .query<{ role: "OWNER" | "MEMBER"; authority_epoch: number }, [string, number]>(
        "SELECT role, authority_epoch FROM members WHERE id = ? AND revision = ? AND status = 'ACTIVE'",
      )
      .get(command.memberId, snapshot.targetRevision);
    if (!actor.ok || !target)
      return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
    if (target.role === "OWNER") {
      const owners = database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM members WHERE role = 'OWNER' AND status = 'ACTIVE'",
        )
        .get()?.count;
      if ((owners ?? 0) <= 1)
        return error("LAST_OWNER_REQUIRED", "At least one active owner is required.");
    }
    const now = dependencies.clock();
    const authorityEpoch = target.authority_epoch + 1;
    const changed = database
      .query(
        `UPDATE members SET status = 'REVOKED', authority_epoch = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND status = 'ACTIVE'`,
      )
      .run(authorityEpoch, command.memberId, snapshot.targetRevision);
    if (changed.changes !== 1)
      return error("AUTHORITY_STALE", "Identity authority changed.", "SAME_INPUT");
    database
      .query(
        "UPDATE member_credentials SET revoked_at = ?, revision = revision + 1 WHERE member_id = ? AND revoked_at IS NULL",
      )
      .run(now, command.memberId);
    database
      .query(
        "UPDATE passkey_credentials SET revoked_at = ?, revision = revision + 1 WHERE member_id = ? AND revoked_at IS NULL",
      )
      .run(now, command.memberId);
    database
      .query(
        "UPDATE sessions SET revoked_at = ?, revision = revision + 1 WHERE member_id = ? AND revoked_at IS NULL",
      )
      .run(now, command.memberId);
    database
      .query(
        "UPDATE device_credential_families SET revoked_at = ?, revision = revision + 1 WHERE member_id = ? AND revoked_at IS NULL",
      )
      .run(now, command.memberId);
    database
      .query(
        `UPDATE device_access_tokens SET revoked_at = ?, revision = revision + 1
         WHERE family_id IN (SELECT id FROM device_credential_families WHERE member_id = ?)
           AND revoked_at IS NULL`,
      )
      .run(now, command.memberId);
    database
      .query(
        "UPDATE encrypted_credentials SET revoked_at = ?, revision = revision + 1, updated_at = ? WHERE owner_kind = 'MEMBER' AND owner_id = ? AND revoked_at IS NULL",
      )
      .run(now, now, command.memberId);
    if (tableExists(database, "outline_member_oauth_grants")) {
      const connectorIds = database
        .query<{ connector_id: string }, [string]>(
          "SELECT DISTINCT connector_id FROM outline_member_oauth_grants WHERE member_id=? AND revoked_at IS NULL",
        )
        .all(command.memberId)
        .map((row) => row.connector_id);
      database
        .query(
          `UPDATE outline_member_oauth_grants SET refresh_status='REVOKED', revoked_at=?,
           revision=revision+1, updated_at=? WHERE member_id=? AND revoked_at IS NULL`,
        )
        .run(now, now, command.memberId);
      database
        .query(
          "UPDATE outline_oauth_transactions SET revoked_at=?,revision=revision+1 WHERE member_id=? AND consumed_at IS NULL AND revoked_at IS NULL",
        )
        .run(now, command.memberId);
      for (const connectorId of connectorIds) {
        database
          .query(
            "UPDATE connector_epochs SET epoch=epoch+1,revision=revision+1 WHERE connector_id=?",
          )
          .run(connectorId);
        database
          .query(
            "UPDATE connector_scopes SET connector_epoch=connector_epoch+1,revision=revision+1 WHERE connector_id=? AND revoked_at IS NULL",
          )
          .run(connectorId);
        database
          .query(
            "UPDATE connector_operation_authorizations SET state='REVOKED' WHERE connector_id=? AND state='RESERVED'",
          )
          .run(connectorId);
        database
          .query(
            "UPDATE connector_operation_intents SET state='REQUIRES_REAUTHORIZATION',updated_at=? WHERE connector_id=? AND state IN ('PENDING','PROVIDER_CONFIRMED')",
          )
          .run(now, connectorId);
        if (tableExists(database, "document_write_grants")) {
          database
            .query(
              "UPDATE document_write_grants SET revoked_at=?,revocation_cause='MEMBER',grant_revision=grant_revision+1 WHERE connector_id=? AND revoked_at IS NULL",
            )
            .run(now, connectorId);
          database
            .query(
              `UPDATE additional_document_requests SET revoked_at=?,revocation_cause='MEMBER',request_revision=request_revision+1
             WHERE grant_id IN (SELECT grant_id FROM document_write_grants WHERE connector_id=?) AND revoked_at IS NULL`,
            )
            .run(now, connectorId);
        }
        if (tableExists(database, "document_proposals")) {
          database
            .query(
              "UPDATE document_proposals SET revoked_at=?,revocation_cause='MEMBER' WHERE connector_id=? AND revoked_at IS NULL",
            )
            .run(now, connectorId);
          database
            .query(
              "UPDATE external_working_documents SET revoked_at=?,revocation_cause='MEMBER',lifecycle_revision=lifecycle_revision+1 WHERE connector_id=? AND revoked_at IS NULL",
            )
            .run(now, connectorId);
        }
      }
    }
    const ownedRunners = database
      .query<{ id: string; runner_epoch: number }, [string]>(
        "SELECT id, runner_epoch FROM runners WHERE owner_member_id = ? AND revoked_at IS NULL",
      )
      .all(command.memberId);
    for (const runner of ownedRunners) {
      const runnerEpoch = runner.runner_epoch + 1;
      database
        .query(
          `UPDATE runners SET runner_epoch = ?, revision = revision + 1, revoked_at = ?
           WHERE id = ? AND runner_epoch = ? AND revoked_at IS NULL`,
        )
        .run(runnerEpoch, now, runner.id, runner.runner_epoch);
      for (const statement of [
        "UPDATE runner_credentials SET revoked_at = ?, revision = revision + 1 WHERE runner_id = ? AND revoked_at IS NULL",
        "UPDATE runner_mapping_versions SET revoked_at = ? WHERE runner_id = ? AND revoked_at IS NULL",
        "UPDATE runner_exposure_acknowledgements SET revoked_at = ? WHERE runner_id = ? AND revoked_at IS NULL",
        "UPDATE runner_exposures SET revoked_at = ?, revision = revision + 1 WHERE runner_id = ? AND revoked_at IS NULL",
      ]) {
        database.query(statement).run(now, runner.id);
      }
      database
        .query(
          `INSERT INTO runner_authority_change_outbox(
             id, runner_id, cause, runner_epoch, status, created_at
           ) VALUES (?, ?, 'MEMBER_OFFBOARDING', ?, 'PENDING', ?)`,
        )
        .run(dependencies.id("runner_authority"), runner.id, runnerEpoch, now);
    }
    database
      .query(
        `UPDATE runner_pairings SET state = 'REVOKED', revoked_at = ?, revision = revision + 1
         WHERE device_member_id = ? AND state IN ('PENDING', 'CONFIRMED')`,
      )
      .run(now, command.memberId);
    database
      .query(
        `INSERT INTO authority_revocation_outbox(
           id, member_id, member_authority_epoch, status, created_at
         ) VALUES (?, ?, ?, 'PENDING', ?)`,
      )
      .run(command.idempotencyKey, command.memberId, authorityEpoch, now);
    database
      .query(
        "INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, 'MEMBER_REVOKED', 'MEMBER', ?, ?, ?, ?)",
      )
      .run(
        dependencies.id("audit"),
        command.actor.memberId,
        command.memberId,
        JSON.stringify({ disposition: "REVOKED", authorityEpoch }),
        now,
      );
    return {
      ok: true,
      value: {
        memberId: command.memberId,
        authorityEpoch,
        disposition: "REVOKED",
        revokedEpochs: ["MEMBER", "RUNNER", "SESSION", "DEVICE"],
        revocationDispatch: "PENDING",
      },
    };
  });
}

export function createMemberRevocationAuthority(dependencies: Dependencies) {
  const browserSessions = createBrowserSessionAuthority(dependencies);
  const revokeOutlineProviderCredentials = async (memberId: string): Promise<boolean> => {
    if (
      !dependencies.outlineProviderRevocation ||
      !tableExists(dependencies.database, "outline_member_oauth_grants")
    )
      return true;
    const credentials = dependencies.database
      .query<{ credential_id: string }, [string]>(
        "SELECT credential_id FROM outline_member_oauth_grants WHERE member_id=? AND revoked_at IS NOT NULL",
      )
      .all(memberId);
    for (const credential of credentials) {
      try {
        const revoked = await dependencies.outlineProviderRevocation.revokeCredential(
          credential.credential_id,
        );
        if (!revoked.ok) return false;
      } catch {
        return false;
      }
    }
    return true;
  };
  return {
    async remove(command: RemoveMember): Promise<Result<MemberRemoval>> {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(command.idempotencyKey) ||
        !Number.isInteger(command.expectedRevision) ||
        command.expectedRevision < 1 ||
        command.actor.sessionProof.length < 32 ||
        command.actor.sessionProof.length > 512
      )
        return error("MEMBER_REMOVAL_INVALID", "Member removal input is invalid.");
      const existing = dependencies.database
        .query<{ member_id: string; member_authority_epoch: number; status: string }, [string]>(
          "SELECT member_id, member_authority_epoch, status FROM authority_revocation_outbox WHERE id = ?",
        )
        .get(command.idempotencyKey);
      if (existing) {
        if (existing.member_id !== command.memberId)
          return error("IDEMPOTENCY_CONFLICT", "Idempotency key was used with different input.");
        let dispatchState = existing.status;
        if (existing.status !== "DISPATCHED") {
          const retried = await dependencies.executionAuthority.execute({
            kind: "APPLY_REVOCATION",
            idempotencyKey: command.idempotencyKey as never,
            actor: command.actor,
            source: {
              kind: "MEMBER",
              memberId: command.memberId,
              authorityEpoch: existing.member_authority_epoch,
            },
          });
          const providerRevoked = await revokeOutlineProviderCredentials(command.memberId);
          if (retried.ok && providerRevoked) {
            try {
              inImmediateTransaction(dependencies.database, () => {
                dependencies.database
                  .query(
                    `UPDATE authority_revocation_outbox SET
                       status = 'DISPATCHED', attempt_count = attempt_count + 1, dispatched_at = ?
                     WHERE id = ? AND status != 'DISPATCHED'`,
                  )
                  .run(dependencies.clock(), command.idempotencyKey);
              });
              dispatchState = "DISPATCHED";
            } catch {
              // The durable intent remains retryable.
            }
          }
        }
        return {
          ok: true,
          value: {
            memberId: command.memberId,
            authorityEpoch: existing.member_authority_epoch,
            disposition: "REVOKED",
            revokedEpochs: ["MEMBER", "RUNNER", "SESSION", "DEVICE"],
            revocationDispatch: dispatchState === "DISPATCHED" ? "DISPATCHED" : "PENDING",
          },
        };
      }
      const actor = await browserSessions.authorize(command.actor, { role: "OWNER" });
      const target = dependencies.database
        .query<{ revision: number; role: "OWNER" | "MEMBER"; authority_epoch: number }, [string]>(
          "SELECT revision, role, authority_epoch FROM members WHERE id = ? AND status = 'ACTIVE'",
        )
        .get(command.memberId);
      if (!actor.ok) return error("OWNER_REQUIRED", "Owner authorization is required.");
      if (!target || target.revision !== command.expectedRevision)
        return error("MEMBER_REVISION_STALE", "Member revision is stale.", "SAME_INPUT");
      let committed: Result<MemberRemoval>;
      try {
        committed = removeMemberTransaction(
          dependencies.database,
          command,
          {
            targetRevision: target.revision,
            targetRole: target.role,
            targetAuthorityEpoch: target.authority_epoch,
            actorAuthority: actor.value,
          },
          { ...dependencies, browserSessions },
        );
      } catch {
        return error("MEMBER_REMOVAL_FAILED", "Member removal failed.");
      }
      if (!committed.ok) return committed;
      let dispatched: Awaited<ReturnType<RevocationExecutionAuthority["execute"]>>;
      try {
        dispatched = await dependencies.executionAuthority.execute({
          kind: "APPLY_REVOCATION",
          idempotencyKey: command.idempotencyKey as never,
          actor: command.actor,
          source: {
            kind: "MEMBER",
            memberId: command.memberId,
            authorityEpoch: committed.value.authorityEpoch,
          },
        });
      } catch {
        dispatched = error("REVOCATION_DISPATCH_FAILED", "Revocation dispatch failed.");
      }
      const providerRevoked = await revokeOutlineProviderCredentials(command.memberId);
      if (dispatched.ok && providerRevoked) {
        try {
          inImmediateTransaction(dependencies.database, () => {
            dependencies.database
              .query(
                `UPDATE authority_revocation_outbox SET
                   status = 'DISPATCHED', attempt_count = attempt_count + 1, dispatched_at = ?
                 WHERE id = ? AND status = 'PENDING'`,
              )
              .run(dependencies.clock(), command.idempotencyKey);
          });
          return {
            ok: true,
            value: { ...committed.value, revocationDispatch: "DISPATCHED" },
          };
        } catch {
          return committed;
        }
      }
      try {
        inImmediateTransaction(dependencies.database, () => {
          dependencies.database
            .query(
              "UPDATE authority_revocation_outbox SET attempt_count = attempt_count + 1 WHERE id = ? AND status = 'PENDING'",
            )
            .run(command.idempotencyKey);
        });
      } catch {
        // The committed removal and pending intent remain authoritative.
      }
      return committed;
    },
  };
}
