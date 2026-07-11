export type WorkflowAuthorityRevocationEvent = Readonly<{
  kind: "MEMBER" | "EXPOSURE" | "CONNECTOR" | "DOCUMENT_GRANT";
  subjectId: string;
  epoch: number;
}>;
export interface WorkflowRevocationTransaction {
  invalidateAffectedLaunchIntents(event: WorkflowAuthorityRevocationEvent): void;
  moveRequiredAffectedWorkflowsToWaiting(
    event: WorkflowAuthorityRevocationEvent,
    reason: "WORKFLOW_AUTHORITY_REVOKED",
  ): void;
  retainUnaffectedActiveWork(): void;
}

export function applyWorkflowRevocation(
  transaction: WorkflowRevocationTransaction,
  event: WorkflowAuthorityRevocationEvent,
): void {
  transaction.invalidateAffectedLaunchIntents(event);
  transaction.moveRequiredAffectedWorkflowsToWaiting(event, "WORKFLOW_AUTHORITY_REVOKED");
  transaction.retainUnaffectedActiveWork();
}
