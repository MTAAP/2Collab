import type { Database } from "bun:sqlite";
import type { SourceRef } from "../../../shared/contracts/context.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import { canonicalSourceReferenceKey } from "./canonical-key.ts";

export function linkSourceReferences(
  database: Database,
  input: Readonly<{
    coordinationRecordId: string;
    projectId: string;
    sourceRefs: readonly SourceRef[];
    linkedAt: number;
    afterWrite?: (table: string) => void;
  }>,
): void {
  const seen = new Set<string>();
  for (const sourceRef of input.sourceRefs) {
    const key = canonicalSourceReferenceKey(
      input.projectId,
      sourceRef.connectorId,
      sourceRef.sourceItemId,
    );
    if (seen.has(key)) throw new Error("COORDINATION_SOURCE_INVALID");
    seen.add(key);
    const existing = database
      .query<{ coordination_record_id: string }, [string, string, string]>(
        `SELECT coordination_record_id FROM coordination_source_references
         WHERE project_id = ? AND connector_id = ? AND source_item_id = ?`,
      )
      .get(input.projectId, sourceRef.connectorId, sourceRef.sourceItemId);
    if (existing && existing.coordination_record_id !== input.coordinationRecordId) {
      throw new Error("COORDINATION_SOURCE_CONFLICT");
    }
    if (existing) continue;
    database
      .query<void, [string, string, string, string, string, string, number]>(
        `INSERT INTO coordination_source_references(
           project_id, connector_id, source_item_id, source_kind,
           coordination_record_id, observed_revision, linked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        sourceRef.connectorId,
        sourceRef.sourceItemId,
        sourceRef.kind,
        input.coordinationRecordId,
        sourceRef.observedRevision,
        input.linkedAt,
      );
    input.afterWrite?.("coordination_source_references");
  }
}

function failure(code: string, retry: "NEVER" | "REFRESH" = "NEVER"): Result<never> {
  return { ok: false, error: { code, message: "Coordination source link failed.", retry } };
}

export function coalesceCoordinationRecords(
  database: Database,
  input: Readonly<{
    projectId: string;
    aliasRecordId: string;
    canonicalRecordId: string;
    actorMemberId: string;
    now: number;
    afterWrite?: (table: string) => void;
  }>,
): Result<Readonly<{ canonicalRecordId: string; aliasRecordId: string; movedRuns: number }>> {
  if (input.aliasRecordId === input.canonicalRecordId) return failure("COORDINATION_ALIAS_INVALID");
  try {
    return inImmediateTransaction(database, () => {
      const member = database
        .query<{ status: string }, [string]>("SELECT status FROM members WHERE id = ?")
        .get(input.actorMemberId);
      const alias = database
        .query<{ project_id: string }, [string]>(
          "SELECT project_id FROM coordination_records WHERE id = ?",
        )
        .get(input.aliasRecordId);
      const canonical = database
        .query<{ project_id: string }, [string]>(
          "SELECT project_id FROM coordination_records WHERE id = ?",
        )
        .get(input.canonicalRecordId);
      if (member?.status !== "ACTIVE") return failure("MEMBER_AUTHORITY_DENIED");
      if (alias?.project_id !== input.projectId || canonical?.project_id !== input.projectId)
        return failure("COORDINATION_RECORD_NOT_FOUND");
      const existingAlias = database
        .query(
          "SELECT 1 FROM coordination_record_aliases WHERE project_id = ? AND alias_record_id IN (?, ?)",
        )
        .get(input.projectId, input.aliasRecordId, input.canonicalRecordId);
      if (existingAlias) return failure("COORDINATION_ALIAS_CONFLICT", "REFRESH");
      database
        .query(
          `INSERT INTO coordination_record_aliases(project_id, alias_record_id, canonical_record_id, reason, actor_member_id, created_at) VALUES (?, ?, ?, 'AUTHORIZED_COALESCE', ?, ?)`,
        )
        .run(
          input.projectId,
          input.aliasRecordId,
          input.canonicalRecordId,
          input.actorMemberId,
          input.now,
        );
      input.afterWrite?.("coordination_record_aliases");
      const auditId = `coordination_coalesce_${input.aliasRecordId}_${input.now}`;
      database
        .query(
          `INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, 'COMMAND_EXECUTED', 'MEMBER', ?, ?, ?, ?)`,
        )
        .run(
          auditId.slice(0, 128),
          input.actorMemberId,
          input.aliasRecordId,
          JSON.stringify({
            disposition: "AUTHORIZED_COALESCE",
            canonicalRecordId: input.canonicalRecordId,
          }),
          input.now,
        );
      return {
        ok: true,
        value: {
          canonicalRecordId: input.canonicalRecordId,
          aliasRecordId: input.aliasRecordId,
          movedRuns: 0,
        },
      };
    });
  } catch {
    return failure("COORDINATION_COALESCE_FAILED", "REFRESH");
  }
}

export function canonicalCoordinationRecord(
  database: Database,
  projectId: string,
  recordId: string,
): string | null {
  const alias = database
    .query<{ canonical_record_id: string }, [string, string]>(
      "SELECT canonical_record_id FROM coordination_record_aliases WHERE project_id = ? AND alias_record_id = ?",
    )
    .get(projectId, recordId);
  if (alias) return alias.canonical_record_id;
  return (
    database
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM coordination_records WHERE project_id = ? AND id = ?",
      )
      .get(projectId, recordId)?.id ?? null
  );
}
