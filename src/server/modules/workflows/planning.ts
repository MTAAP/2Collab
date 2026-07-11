import { PlanArtifactSchema, type PlanArtifact } from "../../../shared/contracts/plan-artifacts.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { Database } from "bun:sqlite";
import { stableJson } from "../templates/run-templates.ts";

type RuntimeIdentity = Readonly<{
  runtime: "CLAUDE" | "CODEX" | "PI" | "OPENCODE";
  runnerId: string;
  host: "NATIVE" | "ORCA";
  interaction: "HEADLESS" | "INTERACTIVE";
}>;
export type AcceptPlanArtifact = Readonly<{
  workflowExecutionId: string;
  stepOccurrenceId: string;
  repositoryMode: "INSPECT_ONLY" | "MUTATING";
  artifact: PlanArtifact;
  producer: RuntimeIdentity;
  consumer: RuntimeIdentity;
}>;

export function acceptPlanArtifact(
  command: AcceptPlanArtifact,
): Result<
  Readonly<{ artifact: PlanArtifact; producer: RuntimeIdentity; consumer: RuntimeIdentity }>
> {
  if (command.repositoryMode !== "INSPECT_ONLY")
    return {
      ok: false,
      error: {
        code: "PLAN_REPOSITORY_MODE_INVALID",
        message: "Planning workflows must be INSPECT_ONLY.",
        retry: "NEVER",
      },
    };
  const artifact = PlanArtifactSchema.safeParse(command.artifact);
  if (!artifact.success)
    return {
      ok: false,
      error: {
        code: "PLAN_ARTIFACT_INVALID",
        message: "The Plan Artifact is invalid.",
        retry: "NEVER",
      },
    };
  return {
    ok: true,
    value: { artifact: artifact.data, producer: command.producer, consumer: command.consumer },
  };
}

export function createPlanArtifactStore(
  dependencies: Readonly<{ database: Database; clock: () => number }>,
) {
  return {
    accept(command: AcceptPlanArtifact) {
      const accepted = acceptPlanArtifact(command);
      if (!accepted.ok) return accepted;
      const existing = dependencies.database
        .query<
          { artifact_json: string; producer_json: string; consumer_json: string },
          [string, string]
        >(
          `SELECT artifact_json, producer_json, consumer_json FROM workflow_plan_artifacts
           WHERE workflow_execution_id = ? AND step_occurrence_id = ?`,
        )
        .get(command.workflowExecutionId, command.stepOccurrenceId);
      const artifactJson = stableJson(accepted.value.artifact);
      const producerJson = stableJson(accepted.value.producer);
      const consumerJson = stableJson(accepted.value.consumer);
      if (existing)
        return existing.artifact_json === artifactJson &&
          existing.producer_json === producerJson &&
          existing.consumer_json === consumerJson
          ? accepted
          : {
              ok: false as const,
              error: {
                code: "PLAN_ARTIFACT_CONFLICT",
                message: "The Plan Artifact was already recorded.",
                retry: "NEVER" as const,
              },
            };
      dependencies.database
        .query<void, [string, string, string, string, string, number]>(
          `INSERT INTO workflow_plan_artifacts(
             workflow_execution_id, step_occurrence_id, artifact_json,
             producer_json, consumer_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.workflowExecutionId,
          command.stepOccurrenceId,
          artifactJson,
          producerJson,
          consumerJson,
          dependencies.clock(),
        );
      return accepted;
    },
    read(workflowExecutionId: string, stepOccurrenceId: string) {
      const row = dependencies.database
        .query<
          { artifact_json: string; producer_json: string; consumer_json: string },
          [string, string]
        >(
          `SELECT artifact_json, producer_json, consumer_json FROM workflow_plan_artifacts
           WHERE workflow_execution_id = ? AND step_occurrence_id = ?`,
        )
        .get(workflowExecutionId, stepOccurrenceId);
      return row
        ? {
            artifact: PlanArtifactSchema.parse(JSON.parse(row.artifact_json)),
            producer: JSON.parse(row.producer_json) as RuntimeIdentity,
            consumer: JSON.parse(row.consumer_json) as RuntimeIdentity,
          }
        : null;
    },
  };
}
