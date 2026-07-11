import type { Database } from "bun:sqlite";
import type { SourceRef } from "../../../shared/contracts/context.ts";
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
