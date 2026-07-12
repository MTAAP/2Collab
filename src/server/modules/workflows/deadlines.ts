import type { WorkflowExecutionState } from "./contract.ts";

export type DeadlineExecution = Readonly<{
  id: string;
  state: WorkflowExecutionState;
  absoluteDeadlineAt: number;
}>;
export interface WorkflowDeadlineTransaction {
  lockExecution(id: string): DeadlineExecution;
  invalidateLaunchIntents(id: string, reason: string): void;
  transition(id: string, state: "FAILED", reason: string): void;
  enqueueOrdinaryRunCancellations(id: string): void;
}

export function expireWorkflow(
  transaction: WorkflowDeadlineTransaction,
  id: string,
  now: number,
): DeadlineExecution {
  const execution = transaction.lockExecution(id);
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(execution.state)) return execution;
  if (now < execution.absoluteDeadlineAt) return execution;
  transaction.invalidateLaunchIntents(id, "WORKFLOW_DEADLINE_EXCEEDED");
  transaction.transition(id, "FAILED", "WORKFLOW_DEADLINE_EXCEEDED");
  transaction.enqueueOrdinaryRunCancellations(id);
  return { ...execution, state: "FAILED" };
}
