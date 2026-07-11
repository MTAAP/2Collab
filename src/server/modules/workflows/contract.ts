import type { MemberActor, SchedulerActor } from "../../../shared/contracts/actors.ts";
import type { LaunchRun } from "../../../shared/contracts/commands.ts";
import type { CoordinationRecordId } from "../../../shared/contracts/ids.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { WorkflowDefinition } from "../../../shared/contracts/workflow.ts";
import type { WorkflowStepResult } from "../../../shared/contracts/workflow-results.ts";

export type WorkflowExecutionState =
  | "ACTIVE"
  | "WAITING"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type StepLaunchConfiguration = Readonly<
  Pick<LaunchRun, "projectId" | "goal" | "repository" | "execution" | "effectiveConfiguration">
>;

export type WorkflowExecutionSnapshot = Readonly<{
  definition: WorkflowDefinition;
  schedulerActor: SchedulerActor;
  launches: Readonly<Record<string, StepLaunchConfiguration>>;
}>;

export type WorkflowExecution = Readonly<{
  id: string;
  coordinationRecordId: CoordinationRecordId;
  coordinationRevision: number;
  templateVersionId: string;
  presetVersionId: string;
  state: WorkflowExecutionState;
  currentNodeKey?: string;
  revision: number;
  absoluteDeadlineAt: number;
  terminalReason?: string;
  createdAt: number;
  updatedAt: number;
}>;

export type StartWorkflow = Readonly<{
  idempotencyKey: string;
  workflowExecutionId: string;
  coordinationRecordId: CoordinationRecordId;
  coordinationRevision: number;
  templateVersionId: string;
  presetVersionId: string;
  definition: WorkflowDefinition;
  schedulerActor: SchedulerActor;
  launches: Readonly<Record<string, StepLaunchConfiguration>>;
}>;

export type WorkflowEventCommand = Readonly<{
  eventId: string;
  actor: SchedulerActor;
  workflowExecutionId: string;
  expectedRevision: number;
  stepOccurrenceId: string;
  runId: string;
  result: WorkflowStepResult;
}>;

export type RecordHumanDecision = Readonly<{
  decisionId: string;
  workflowExecutionId: string;
  nodeKey: string;
  choice: string;
  actor: MemberActor;
  expectedRevision: number;
}>;

export type WorkflowControlCommand = Readonly<{
  idempotencyKey: string;
  actor: MemberActor;
  workflowExecutionId: string;
  expectedRevision: number;
}>;

export interface WorkflowEngine {
  start(command: StartWorkflow): Promise<Result<WorkflowExecution>>;
  accept(command: WorkflowEventCommand): Promise<Result<WorkflowExecution>>;
  decide(command: RecordHumanDecision): Promise<Result<WorkflowExecution>>;
  pause(command: WorkflowControlCommand): Promise<Result<WorkflowExecution>>;
  resume(command: WorkflowControlCommand): Promise<Result<WorkflowExecution>>;
  inspect(workflowExecutionId: string): Result<WorkflowExecution>;
  tick(): Promise<void>;
  failAfterIntentCommitOnce(): void;
}
