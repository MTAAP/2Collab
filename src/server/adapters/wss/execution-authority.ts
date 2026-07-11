import type { VerifiedRunnerPrincipal } from "../../../shared/contracts/actors.ts";
import {
  type CollabCommand,
  CollabCommandSchema,
  type CommandResult,
} from "../../../shared/contracts/commands.ts";
import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import type { RunnerEnvelope, ServerEnvelope } from "../../../shared/contracts/protocol.ts";
import type { Result } from "../../../shared/contracts/result.ts";

export type RunnerSemanticBody = Exclude<
  RunnerEnvelope["body"],
  Readonly<{
    kind: "HEARTBEAT" | "HEADLESS_OUTPUT_CHUNK" | "OPERATION_ACKNOWLEDGEMENT" | "GATE_EVENT";
  }>
>;

export type RunnerSemanticAcceptance = Readonly<{
  disposition: "APPLIED" | "REJECTED";
  response?: ServerEnvelope["body"];
}>;

type AuthorityCommandResult = Extract<
  CommandResult,
  {
    kind:
      | "CONSUME_PERMIT"
      | "RENEW_AUTHORITY_SESSION"
      | "AUTHORIZE_OPERATION"
      | "RELEASE_AUTHORITY_SESSION";
  }
>;

export function createRunnerExecutionAuthorityAdapter(authority: ExecutionAuthority) {
  return {
    async accept(
      body: RunnerSemanticBody,
      principal: VerifiedRunnerPrincipal,
      connectionId: string,
    ) {
      const base = {
        idempotencyKey: body.eventId,
        actor: {
          kind: "RUNNER" as const,
          runnerId: principal.runnerId,
          runnerEpoch: principal.runnerEpoch,
        },
      };
      let candidate: unknown;
      switch (body.kind) {
        case "CONSUME_DISPATCH_PERMIT":
          candidate = {
            ...base,
            kind: "CONSUME_PERMIT",
            ...body.payload,
            runnerId: principal.runnerId,
            runnerEpoch: principal.runnerEpoch,
            connectionId,
          };
          break;
        case "RENEW_AUTHORITY_SESSION":
          candidate = {
            ...base,
            kind: "RENEW_AUTHORITY_SESSION",
            ...body.payload,
            runnerEpoch: principal.runnerEpoch,
          };
          break;
        case "RELEASE_AUTHORITY_SESSION":
          candidate = { ...base, kind: "RELEASE_AUTHORITY_SESSION", ...body.payload };
          break;
        case "AUTHORIZE_OPERATION":
          candidate = { ...base, kind: "AUTHORIZE_OPERATION", ...body.payload };
          break;
        case "ATTEMPT_EVENT":
          candidate = { ...base, kind: "ACCEPT_ATTEMPT_EVENT", ...body.payload };
          break;
        case "CHECKPOINT":
          candidate = {
            ...base,
            kind: "RECORD_CHECKPOINT",
            ...body.payload,
            runnerId: principal.runnerId,
          };
          break;
        case "EVIDENCE":
          candidate = { ...base, kind: "RECORD_EVIDENCE", ...body.payload };
          break;
        case "RUN_RESULT":
          candidate = { ...base, kind: "RECORD_RUN_RESULT", ...body.payload };
          break;
      }
      const command = CollabCommandSchema.safeParse(candidate);
      if (!command.success) {
        return {
          ok: false,
          error: {
            code: "RUNNER_SEMANTIC_COMMAND_INVALID",
            message: "Runner semantic command is invalid.",
            retry: "NEVER",
          },
        } satisfies Result<never>;
      }
      const result = await authority.execute(command.data as CollabCommand);
      const requestId = "requestId" in body ? body.requestId : undefined;
      if (!requestId) {
        return {
          ok: true as const,
          value: { disposition: result.ok ? "APPLIED" : "REJECTED" } as const,
        };
      }
      const response: ServerEnvelope["body"] = {
        kind: "AUTHORITY_RESPONSE",
        requestId,
        result: result.ok
          ? (result.value as AuthorityCommandResult)
          : { kind: "ERROR", code: result.error.code, retry: result.error.retry },
      };
      return {
        ok: true as const,
        value: {
          disposition: result.ok ? ("APPLIED" as const) : ("REJECTED" as const),
          response,
        },
      };
    },
  };
}
