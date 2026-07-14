import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type {
  RecordHumanDecision,
  StartWorkflow,
  WorkflowControlCommand,
  WorkflowEventCommand,
  WorkflowExecution,
} from "./contract.ts";

export type WorkflowRuntimeOperations = Readonly<{
  start(
    actor: MemberActor,
    command: Omit<StartWorkflow, "schedulerActor">,
  ): Promise<Result<WorkflowExecution>>;
  show(actor: MemberActor, workflowExecutionId: string): Promise<Result<WorkflowExecution>>;
  pause(
    actor: MemberActor,
    command: Omit<WorkflowControlCommand, "actor">,
  ): Promise<Result<WorkflowExecution>>;
  resume(
    actor: MemberActor,
    command: Omit<WorkflowControlCommand, "actor">,
  ): Promise<Result<WorkflowExecution>>;
  cancel(
    actor: MemberActor,
    command: Omit<WorkflowControlCommand, "actor">,
  ): Promise<Result<WorkflowExecution>>;
  decide(
    actor: MemberActor,
    command: Omit<RecordHumanDecision, "actor">,
  ): Promise<Result<WorkflowExecution>>;
  event(
    actor: MemberActor,
    command: Omit<WorkflowEventCommand, "actor">,
  ): Promise<Result<WorkflowExecution>>;
}>;
