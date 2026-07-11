import { PlanArtifactSchema, type PlanArtifact } from "../../../shared/contracts/plan-artifacts.ts";
import type { Result } from "../../../shared/contracts/result.ts";

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
