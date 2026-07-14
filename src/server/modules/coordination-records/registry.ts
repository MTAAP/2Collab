import type { Database } from "bun:sqlite";
import type { CoordinationSelection } from "../../../shared/contracts/context.ts";
import type { CoordinationRecordView } from "../../../shared/contracts/runs.ts";
import type { CoordinationRecordId, ProjectId } from "../../../shared/contracts/ids.ts";
import { linkSourceReferences } from "./source-links.ts";

type CoordinationRow = Readonly<{
  id: string;
  project_id: string;
  title: string;
  revision: number;
}>;

export function resolveCoordinationForLaunch(
  database: Database,
  input: Readonly<{
    selection: CoordinationSelection;
    projectId: string;
    candidateId: string;
    now: number;
    afterWrite?: (table: string) => void;
  }>,
): CoordinationRow {
  if (input.selection.kind === "NEW") {
    database
      .query<void, [string, string, string, number, number, number]>(
        `INSERT INTO coordination_records(id, project_id, title, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.candidateId, input.projectId, input.selection.title, 1, input.now, input.now);
    input.afterWrite?.("coordination_records");
    linkSourceReferences(database, {
      coordinationRecordId: input.candidateId,
      projectId: input.projectId,
      sourceRefs: input.selection.sourceRefs,
      linkedAt: input.now,
      afterWrite: input.afterWrite,
    });
    return {
      id: input.candidateId,
      project_id: input.projectId,
      title: input.selection.title,
      revision: 1,
    };
  }
  const existing = database
    .query<CoordinationRow, [string]>(
      "SELECT id, project_id, title, revision FROM coordination_records WHERE id = ?",
    )
    .get(input.selection.coordinationRecordId);
  if (!existing || existing.project_id !== input.projectId) {
    throw new Error("COORDINATION_RECORD_NOT_FOUND");
  }
  const changed = database
    .query<void, [number, number, string, number]>(
      `UPDATE coordination_records SET revision = ?, updated_at = ?
       WHERE id = ? AND revision = ?`,
    )
    .run(existing.revision + 1, input.now, existing.id, input.selection.expectedRevision);
  if (changed.changes !== 1) throw new Error("COORDINATION_REVISION_CONFLICT");
  input.afterWrite?.("coordination_records");
  return { ...existing, revision: existing.revision + 1 };
}

export function coordinationRecordView(
  database: Database,
  row: CoordinationRow,
): CoordinationRecordView {
  return {
    id: row.id as CoordinationRecordId,
    projectId: row.project_id as ProjectId,
    title: row.title,
    revision: row.revision,
    runIds: database
      .query<{ id: string }, [string]>(
        "SELECT id FROM agent_runs WHERE coordination_record_id = ? ORDER BY created_at, id",
      )
      .all(row.id)
      .map((run) => run.id as CoordinationRecordView["runIds"][number]),
  };
}
