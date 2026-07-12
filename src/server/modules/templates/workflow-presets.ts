import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { PersonalWorkflowPreset } from "../../../shared/contracts/templates.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import { stableJson } from "./run-templates.ts";
import { resolveWorkflowBindings, type ResolvedWorkflowBindings } from "./bindings.ts";
import { GitRefSchema } from "../../../shared/contracts/runners.ts";

type Dependencies = Readonly<{
  database: Database;
  authority: ExecutionAuthority;
  clock: () => number;
}>;
export type BindPersonalWorkflowPreset = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  preset: PersonalWorkflowPreset;
}>;
export type BoundPersonalWorkflowPreset = PersonalWorkflowPreset &
  Readonly<{ resolvedBindings: ResolvedWorkflowBindings }>;

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}
function failure<T>(
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" = "NEVER",
): Result<T> {
  return { ok: false, error: { code, message, retry } };
}

function validWorkflowBinding(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  const repository = binding.repository;
  if (!repository || typeof repository !== "object") return false;
  const selection = repository as Record<string, unknown>;
  return (
    typeof binding.personalRunPresetId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(binding.personalRunPresetId) &&
    Number.isInteger(binding.expectedVersion) &&
    (binding.expectedVersion as number) > 0 &&
    typeof selection.repositoryId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(selection.repositoryId) &&
    (selection.intendedBranch === undefined ||
      (typeof selection.intendedBranch === "string" &&
        GitRefSchema.safeParse(selection.intendedBranch).success))
  );
}

export function createWorkflowPresetRegistry(dependencies: Dependencies) {
  return {
    async bind(command: BindPersonalWorkflowPreset): Promise<Result<BoundPersonalWorkflowPreset>> {
      const requestDigest = digest(command);
      const prior = dependencies.database
        .query<{ request_digest: string; result_json: string }, [string]>(
          "SELECT request_digest, result_json FROM template_registry_writes WHERE idempotency_key = ?",
        )
        .get(command.idempotencyKey);
      if (prior)
        return prior.request_digest === requestDigest
          ? (JSON.parse(prior.result_json) as Result<BoundPersonalWorkflowPreset>)
          : failure("IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used.");
      if (
        command.preset.ownerMemberId !== command.actor.memberId ||
        command.preset.version < 1 ||
        Object.keys(command.preset.bindings).length === 0 ||
        Object.values(command.preset.bindings).some((binding) => !validWorkflowBinding(binding))
      )
        return failure("WORKFLOW_PRESET_INVALID", "The Personal Workflow Preset is invalid.");
      const resolved = await resolveWorkflowBindings(
        command.preset,
        command.actor,
        dependencies.authority,
      );
      if (!resolved.ok) return resolved;
      return inImmediateTransaction(dependencies.database, () => {
        const existing = dependencies.database
          .query<{ present: number }, [string, number]>(
            "SELECT 1 AS present FROM personal_workflow_presets WHERE id = ? AND version = ?",
          )
          .get(command.preset.id, command.preset.version);
        if (existing)
          return failure(
            "WORKFLOW_PRESET_VERSION_CONFLICT",
            "The workflow preset version already exists.",
            "REFRESH",
          );
        const value: BoundPersonalWorkflowPreset = {
          ...command.preset,
          createdAt: dependencies.clock(),
          resolvedBindings: resolved.value,
        };
        const result = { ok: true as const, value };
        dependencies.database
          .query<void, [string, string, number, string, string, number]>(
            `INSERT INTO personal_workflow_presets(
               id, owner_member_id, version, workflow_template_version_id, bindings_json, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            value.id,
            value.ownerMemberId,
            value.version,
            value.workflowTemplateVersionId,
            stableJson(value.bindings),
            value.createdAt,
          );
        dependencies.database
          .query<void, [string, string, string, string, number]>(
            `INSERT INTO template_registry_writes(
               idempotency_key, actor_member_id, operation_kind, request_digest, result_json, created_at
             ) VALUES (?, ?, 'BIND_WORKFLOW_PRESET', ?, ?, ?)`,
          )
          .run(
            command.idempotencyKey,
            command.actor.memberId,
            requestDigest,
            JSON.stringify(result),
            dependencies.clock(),
          );
        return result;
      });
    },
  };
}
