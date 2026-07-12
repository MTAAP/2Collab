import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import type { Sha256 } from "../../../shared/contracts/ids.ts";
import type { StepLaunchConfiguration, WorkflowExecutionSnapshot } from "./contract.ts";

export type WorkflowLaunchIntent = Readonly<{
  idempotencyKey: string;
  workflowExecutionId: string;
  stepOccurrenceId: string;
  workflowRevision: number;
  configuration: StepLaunchConfiguration;
}>;

export async function dispatchStep(
  intent: WorkflowLaunchIntent,
  execution: Readonly<{ coordinationRecordId: string; coordinationRevision: number }>,
  snapshot: WorkflowExecutionSnapshot,
  authority: ExecutionAuthority,
) {
  return authority.execute({
    kind: "LAUNCH_RUN",
    idempotencyKey: intent.idempotencyKey as never,
    actor: snapshot.schedulerActor,
    projectId: intent.configuration.projectId,
    coordination: {
      kind: "EXISTING",
      coordinationRecordId: execution.coordinationRecordId as never,
      expectedRevision: execution.coordinationRevision,
    },
    goal: intent.configuration.goal,
    repository: intent.configuration.repository,
    execution: intent.configuration.execution,
    effectiveConfiguration: intent.configuration.effectiveConfiguration,
    workflow: {
      workflowExecutionId: intent.workflowExecutionId as never,
      stepOccurrenceId: intent.stepOccurrenceId,
      workflowRevision: intent.workflowRevision,
      effectiveConfigurationDigest: intent.configuration.effectiveConfiguration.digest as Sha256,
    },
  });
}
