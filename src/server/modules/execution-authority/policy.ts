import type { Database } from "bun:sqlite";
import type { AuthenticatedActor } from "../../../shared/contracts/actors.ts";
import type { CollabCommand, SensitiveOperation } from "../../../shared/contracts/commands.ts";
import type { DomainError, Result } from "../../../shared/contracts/result.ts";

export type SafeActor = Readonly<{
  kind: "MEMBER" | "SCHEDULER" | "RUNNER";
  id: string;
  contextId?: string;
}>;

export function error<T>(
  code: string,
  message: string,
  retry: DomainError["retry"] = "NEVER",
): Result<T> {
  return { ok: false, error: { code, message, retry } };
}

export function safeActor(actor: AuthenticatedActor): SafeActor {
  if (actor.kind === "MEMBER") {
    return { kind: actor.kind, id: actor.memberId, contextId: actor.sessionId };
  }
  if (actor.kind === "SCHEDULER") {
    return {
      kind: actor.kind,
      id: actor.originalDispatcherId,
      ...(actor.workflowExecutionId ? { contextId: actor.workflowExecutionId } : {}),
    };
  }
  return { kind: actor.kind, id: actor.runnerId, contextId: String(actor.runnerEpoch) };
}

export function requireActivePrincipal(
  database: Database,
  actor: AuthenticatedActor,
): Result<SafeActor> {
  const safe = safeActor(actor);
  if (actor.kind === "RUNNER") {
    const row = database
      .query<{ runner_epoch: number; revoked_at: number | null }, [string]>(
        "SELECT runner_epoch, revoked_at FROM runners WHERE id = ?",
      )
      .get(actor.runnerId);
    return row && row.revoked_at === null && row.runner_epoch === actor.runnerEpoch
      ? { ok: true, value: safe }
      : error("RUNNER_EPOCH_CHANGED", "Runner authority changed.", "REFRESH");
  }
  const member = database
    .query<{ status: string }, [string]>("SELECT status FROM members WHERE id = ?")
    .get(safe.id);
  return member?.status === "ACTIVE"
    ? { ok: true, value: safe }
    : error("MEMBER_REVOKED", "Member authority is no longer active.", "REFRESH");
}

export function actorMayExecute(command: CollabCommand): boolean {
  switch (command.kind) {
    case "LAUNCH_RUN":
    case "AUTHORIZE_ATTEMPT":
      return command.actor.kind === "MEMBER" || command.actor.kind === "SCHEDULER";
    case "CANCEL_RUN":
      return command.actor.kind === "MEMBER" || command.actor.kind === "SCHEDULER";
    case "LINK_SOURCE_REFERENCE":
    case "ACKNOWLEDGE_COLLISION":
    case "REPLACE_RUNNER_POLICY":
      return command.actor.kind === "MEMBER";
    case "CONSUME_PERMIT":
    case "RENEW_AUTHORITY_SESSION":
    case "AUTHORIZE_OPERATION":
    case "RELEASE_AUTHORITY_SESSION":
    case "ACCEPT_ATTEMPT_EVENT":
    case "RECORD_CHECKPOINT":
    case "RECORD_EVIDENCE":
    case "RECORD_RUN_RESULT":
      return command.actor.kind === "RUNNER";
    case "RECONCILE_OBSERVATION":
      return command.actor.kind === "RUNNER" || command.actor.kind === "SCHEDULER";
    case "APPLY_REVOCATION":
      if (command.source.kind === "RUNNER") {
        return (
          (command.actor.kind === "RUNNER" && command.actor.runnerId === command.source.runnerId) ||
          command.actor.kind === "MEMBER"
        );
      }
      return command.actor.kind === "MEMBER" || command.actor.kind === "SCHEDULER";
  }
}

export function operationNeedsMutationLease(operation: SensitiveOperation): boolean {
  return (
    operation.kind === "MUTATE_REPOSITORY" ||
    operation.kind === "PUBLISH_GIT_REFERENCE" ||
    operation.kind === "MUTATE_GITHUB" ||
    operation.kind === "MUTATE_OUTLINE" ||
    operation.kind === "APPLY_APPROVAL_TRANSITION"
  );
}

export function inspectOnlyMayAuthorize(operation: SensitiveOperation): boolean {
  return operation.kind === "EXECUTE_LOCAL_GATE";
}

export function operationConnector(
  operation: SensitiveOperation,
): Readonly<{ connectorId: string; connectorEpoch: number; projectId: string }> | undefined {
  return operation.kind === "MUTATE_GITHUB" || operation.kind === "MUTATE_OUTLINE"
    ? {
        connectorId: operation.connectorId,
        connectorEpoch: operation.connectorEpoch,
        projectId: operation.projectId,
      }
    : undefined;
}
