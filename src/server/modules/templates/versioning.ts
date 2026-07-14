import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Result } from "../../../shared/contracts/result.ts";
import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import type {
  BindWorkflowPreset,
  TeamRunTemplateDraft,
  TeamRunTemplateVersion,
} from "../../../shared/contracts/templates.ts";
import {
  CanvasLayoutSchema,
  type CanvasLayout,
  type WorkflowDefinition,
} from "../../../shared/contracts/workflow.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import { semanticHash } from "../workflows/definition.ts";
import { layoutHash } from "../workflows/versioning.ts";
import { validateWorkflow } from "../workflows/validation.ts";
import type { TemplateRegistry } from "./contract.ts";
import { runTemplateHash, sanitizeRunTemplate, stableJson } from "./run-templates.ts";
import { createWorkflowPresetRegistry } from "./workflow-presets.ts";

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
  authority?: ExecutionAuthority;
}>;
export type PublishWorkflowTemplate = Readonly<{
  idempotencyKey: string;
  actorMemberId: string;
  templateKey: string;
  expectedVersion: number;
  definition: WorkflowDefinition;
  layout: CanvasLayout;
  runTemplates: ReadonlyMap<string, TeamRunTemplateVersion>;
}>;
export type TeamWorkflowTemplateVersion = Readonly<{
  id: string;
  templateKey: string;
  version: number;
  definition: WorkflowDefinition;
  semanticHash: string;
}>;

function failure<T>(
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" | "EXPLICIT_RESUME" | "SAME_INPUT" = "NEVER",
): Result<T> {
  return { ok: false, error: { code, message, retry } };
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function replay<T>(database: Database, key: string, requestDigest: string): Result<T> | null {
  const row = database
    .query<{ request_digest: string; result_json: string }, [string]>(
      "SELECT request_digest, result_json FROM template_registry_writes WHERE idempotency_key = ?",
    )
    .get(key);
  if (!row) return null;
  if (row.request_digest !== requestDigest)
    return failure("IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used.");
  return JSON.parse(row.result_json) as Result<T>;
}

function remember(
  dependencies: Dependencies,
  input: Readonly<{
    key: string;
    actorMemberId: string;
    kind: "PUBLISH_RUN_TEMPLATE" | "PUBLISH_WORKFLOW_TEMPLATE" | "BIND_WORKFLOW_PRESET";
    requestDigest: string;
    result: Result<unknown>;
  }>,
): void {
  dependencies.database
    .query<void, [string, string, string, string, string, number]>(
      `INSERT INTO template_registry_writes(
         idempotency_key, actor_member_id, operation_kind, request_digest, result_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.key,
      input.actorMemberId,
      input.kind,
      input.requestDigest,
      JSON.stringify(input.result),
      dependencies.clock(),
    );
}

function activeMember(database: Database, memberId: string): boolean {
  return Boolean(
    database
      .query<{ present: number }, [string]>(
        "SELECT 1 AS present FROM members WHERE id = ? AND status = 'ACTIVE'",
      )
      .get(memberId),
  );
}

export function createTemplateRegistry(dependencies: Dependencies): TemplateRegistry {
  return {
    async publishRunTemplate(command) {
      const requestDigest = digest(command);
      const prior = replay<TeamRunTemplateVersion>(
        dependencies.database,
        command.idempotencyKey,
        requestDigest,
      );
      if (prior) return prior;
      if (!activeMember(dependencies.database, command.actorMemberId))
        return failure("MEMBER_AUTHORITY_REQUIRED", "Active member authority is required.");
      let definition: TeamRunTemplateDraft;
      try {
        definition = sanitizeRunTemplate(command.definition);
      } catch (error) {
        return failure(
          error instanceof Error && error.message === "TEMPLATE_PRIVATE_EXECUTION_DATA"
            ? error.message
            : "TEMPLATE_INVALID",
          "The Run Template is invalid.",
        );
      }
      return inImmediateTransaction(dependencies.database, () => {
        const current = dependencies.database
          .query<{ version: number }, [string]>(
            "SELECT max(version) AS version FROM team_run_template_versions WHERE template_key = ?",
          )
          .get(command.templateKey)?.version;
        if ((current ?? 0) !== command.expectedVersion)
          return failure(
            "TEMPLATE_VERSION_CONFLICT",
            "The Run Template version changed.",
            "REFRESH",
          );
        const version = command.expectedVersion + 1;
        const value: TeamRunTemplateVersion = {
          id: `${command.templateKey}_v${version}`,
          templateKey: command.templateKey,
          version,
          definition,
          semanticHash: runTemplateHash(definition),
        };
        const result = { ok: true as const, value };
        dependencies.database
          .query<void, [string, string, number, string | null, string, string, string, number]>(
            `INSERT INTO team_run_template_versions(
               id, template_key, version, project_id, definition_json, semantic_hash,
               published_by_member_id, published_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            value.id,
            value.templateKey,
            value.version,
            definition.projectId ?? null,
            stableJson(definition),
            value.semanticHash,
            command.actorMemberId,
            dependencies.clock(),
          );
        remember(dependencies, {
          key: command.idempotencyKey,
          actorMemberId: command.actorMemberId,
          kind: "PUBLISH_RUN_TEMPLATE",
          requestDigest,
          result,
        });
        return result;
      });
    },

    async publishWorkflowTemplate(command) {
      const requestDigest = digest({ ...command, runTemplates: [...command.runTemplates.keys()] });
      const prior = replay<TeamWorkflowTemplateVersion>(
        dependencies.database,
        command.idempotencyKey,
        requestDigest,
      );
      if (prior) return prior;
      if (!activeMember(dependencies.database, command.actorMemberId))
        return failure("MEMBER_AUTHORITY_REQUIRED", "Active member authority is required.");
      const diagnostics = validateWorkflow(command.definition, command.runTemplates);
      const parsedLayout = CanvasLayoutSchema.safeParse(command.layout);
      const definitionKeys = new Set(command.definition.nodes.map((node) => node.key));
      if (
        diagnostics.length > 0 ||
        !parsedLayout.success ||
        parsedLayout.data.nodes.length !== definitionKeys.size ||
        parsedLayout.data.nodes.some((node) => !definitionKeys.has(node.key))
      )
        return failure("WORKFLOW_INVALID", "The Workflow Definition is invalid.");
      return inImmediateTransaction(dependencies.database, () => {
        const current = dependencies.database
          .query<{ version: number }, [string]>(
            "SELECT max(version) AS version FROM team_workflow_template_versions WHERE template_key = ?",
          )
          .get(command.templateKey)?.version;
        if ((current ?? 0) !== command.expectedVersion)
          return failure(
            "TEMPLATE_VERSION_CONFLICT",
            "The Workflow Template version changed.",
            "REFRESH",
          );
        const version = command.expectedVersion + 1;
        const value: TeamWorkflowTemplateVersion = {
          id: `${command.templateKey}_v${version}`,
          templateKey: command.templateKey,
          version,
          definition: command.definition,
          semanticHash: semanticHash(command.definition),
        };
        const result = { ok: true as const, value };
        dependencies.database
          .query<void, [string, string, number, string, string, string, number]>(
            `INSERT INTO team_workflow_template_versions(
               id, template_key, version, definition_json, semantic_hash,
               published_by_member_id, published_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            value.id,
            value.templateKey,
            value.version,
            stableJson(value.definition),
            value.semanticHash,
            command.actorMemberId,
            dependencies.clock(),
          );
        dependencies.database
          .query<void, [string, string, string, string, number]>(
            `INSERT INTO workflow_canvas_layouts(
               workflow_template_version_id, revision, layout_json, layout_hash,
               saved_by_member_id, saved_at
             ) VALUES (?, 1, ?, ?, ?, ?)`,
          )
          .run(
            value.id,
            stableJson(parsedLayout.data),
            layoutHash(parsedLayout.data),
            command.actorMemberId,
            dependencies.clock(),
          );
        remember(dependencies, {
          key: command.idempotencyKey,
          actorMemberId: command.actorMemberId,
          kind: "PUBLISH_WORKFLOW_TEMPLATE",
          requestDigest,
          result,
        });
        return result;
      });
    },

    async bind(command: BindWorkflowPreset) {
      if (!dependencies.authority)
        return failure(
          "PRESET_BINDING_REQUIRED",
          "Workflow bindings must be resolved before storage.",
          "EXPLICIT_RESUME",
        );
      return createWorkflowPresetRegistry({
        database: dependencies.database,
        authority: dependencies.authority,
        clock: dependencies.clock,
      }).bind(command);
    },
  };
}
