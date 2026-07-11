import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Result } from "../../../shared/contracts/result.ts";
import {
  CanvasLayoutSchema,
  WorkflowDefinitionSchema,
  type CanvasLayout,
  type WorkflowDefinition,
  type WorkflowDraft,
} from "../../../shared/contracts/workflow.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import { stableJson } from "../templates/run-templates.ts";

export type SaveWorkflowDraft = Readonly<{
  idempotencyKey: string;
  actorMemberId: string;
  draftId: string;
  templateKey: string;
  expectedRevision: number;
  definition: WorkflowDefinition;
  layout: CanvasLayout;
}>;
export type DuplicateWorkflowDraft = Readonly<{
  idempotencyKey: string;
  actorMemberId: string;
  draftId: string;
}>;

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
}>;
type DraftRow = Readonly<{
  id: string;
  template_key: string;
  revision: number;
  definition_json: string;
  layout_json: string;
  updated_by_member_id: string;
  updated_at: number;
}>;

function failure<T>(
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" = "NEVER",
): Result<T> {
  return { ok: false, error: { code, message, retry } };
}
function rowToDraft(row: DraftRow): WorkflowDraft {
  return {
    id: row.id,
    templateKey: row.template_key,
    revision: row.revision,
    definition: WorkflowDefinitionSchema.parse(JSON.parse(row.definition_json)),
    layout: CanvasLayoutSchema.parse(JSON.parse(row.layout_json)),
    updatedByMemberId: row.updated_by_member_id,
    updatedAt: row.updated_at,
  };
}
function requestDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function createWorkflowDraftStore(dependencies: Dependencies) {
  const read = (id: string): WorkflowDraft | null => {
    const row = dependencies.database
      .query<DraftRow, [string]>("SELECT * FROM workflow_drafts WHERE id = ?")
      .get(id);
    return row ? rowToDraft(row) : null;
  };
  const remember = (
    key: string,
    actorMemberId: string,
    kind: "SAVE_WORKFLOW_DRAFT" | "DUPLICATE_WORKFLOW_DRAFT",
    digest: string,
    result: Result<WorkflowDraft>,
  ): void => {
    dependencies.database
      .query<void, [string, string, string, string, string, number]>(
        `INSERT INTO template_registry_writes(
           idempotency_key, actor_member_id, operation_kind, request_digest, result_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(key, actorMemberId, kind, digest, JSON.stringify(result), dependencies.clock());
  };
  const replay = (key: string, digest: string): Result<WorkflowDraft> | null => {
    const prior = dependencies.database
      .query<{ request_digest: string; result_json: string }, [string]>(
        "SELECT request_digest, result_json FROM template_registry_writes WHERE idempotency_key = ?",
      )
      .get(key);
    if (!prior) return null;
    return prior.request_digest === digest
      ? (JSON.parse(prior.result_json) as Result<WorkflowDraft>)
      : failure("IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used.");
  };

  return {
    read,
    save(command: SaveWorkflowDraft): Result<WorkflowDraft> {
      const digest = requestDigest(command);
      const prior = replay(command.idempotencyKey, digest);
      if (prior) return prior;
      const definition = WorkflowDefinitionSchema.safeParse(command.definition);
      const layout = CanvasLayoutSchema.safeParse(command.layout);
      if (!definition.success || !layout.success)
        return failure("WORKFLOW_DRAFT_INVALID", "The Workflow Draft is invalid.");
      return inImmediateTransaction(dependencies.database, () => {
        const current = read(command.draftId);
        if ((current?.revision ?? 0) !== command.expectedRevision)
          return failure(
            "WORKFLOW_DRAFT_REVISION_STALE",
            "The Workflow Draft changed. Reload or duplicate it.",
            "REFRESH",
          );
        const revision = command.expectedRevision + 1;
        const now = dependencies.clock();
        dependencies.database
          .query<void, [string, string, number, string, string, string, number]>(
            `INSERT INTO workflow_drafts(
               id, template_key, revision, definition_json, layout_json,
               updated_by_member_id, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               revision = excluded.revision,
               definition_json = excluded.definition_json,
               layout_json = excluded.layout_json,
               updated_by_member_id = excluded.updated_by_member_id,
               updated_at = excluded.updated_at`,
          )
          .run(
            command.draftId,
            command.templateKey,
            revision,
            stableJson(definition.data),
            stableJson(layout.data),
            command.actorMemberId,
            now,
          );
        dependencies.database
          .query<void, [string, number, string, string, string, number]>(
            `INSERT INTO workflow_draft_history(
               draft_id, revision, definition_json, layout_json, authored_by_member_id, authored_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            command.draftId,
            revision,
            stableJson(definition.data),
            stableJson(layout.data),
            command.actorMemberId,
            now,
          );
        const result = { ok: true as const, value: read(command.draftId) as WorkflowDraft };
        remember(
          command.idempotencyKey,
          command.actorMemberId,
          "SAVE_WORKFLOW_DRAFT",
          digest,
          result,
        );
        return result;
      });
    },
    duplicate(command: DuplicateWorkflowDraft): Result<WorkflowDraft> {
      const digest = requestDigest(command);
      const prior = replay(command.idempotencyKey, digest);
      if (prior) return prior;
      const source = read(command.draftId);
      if (!source) return failure("WORKFLOW_DRAFT_NOT_FOUND", "The Workflow Draft was not found.");
      const copyId = dependencies.id("draft");
      return this.save({
        idempotencyKey: command.idempotencyKey,
        actorMemberId: command.actorMemberId,
        draftId: copyId,
        templateKey: source.templateKey,
        expectedRevision: 0,
        definition: source.definition,
        layout: source.layout,
      });
    },
  };
}
