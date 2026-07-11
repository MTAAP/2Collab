import type { Result } from "../../../shared/contracts/result.ts";
import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type {
  AuthorizeAttempt,
  CancelRun,
  InspectEvidence,
  InspectRun,
  LaunchRun,
} from "../../../shared/contracts/commands.ts";
import type {
  PublicCreateRunRequest,
  PublicResumeRunRequest,
} from "../../../shared/contracts/public-api.ts";
import type { PublicRunOperations } from "./contract.ts";

function notImplemented(): Result<never> {
  return {
    ok: false,
    error: {
      code: "RUNS_NOT_IMPLEMENTED",
      message: "Run operations are not implemented.",
      retry: "NEVER",
    },
  };
}

export function createStubRunOperations(): PublicRunOperations {
  return {
    create: async () => notImplemented(),
    inspect: async () => notImplemented(),
    cancel: async () => notImplemented(),
    resume: async () => notImplemented(),
    evidence: async () => notImplemented(),
  };
}

type LaunchResolution = Readonly<{
  repository: LaunchRun["repository"];
  execution: LaunchRun["execution"];
  effectiveConfiguration: LaunchRun["effectiveConfiguration"];
}>;

type Dependencies = Readonly<{
  authority: ExecutionAuthority;
  resolveLaunch(
    actor: MemberActor,
    request: PublicCreateRunRequest | PublicResumeRunRequest,
  ): Promise<Result<LaunchResolution>>;
}>;

function publicRun(
  run: Readonly<{
    id: string;
    coordinationRecordId: string;
    state: "QUEUED" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELLED";
    goal: string;
    repositoryMode: "INSPECT_ONLY" | "MUTATING";
    repositoryAssurance: "ADVISORY" | "ENFORCED";
    revision: number;
    attemptIds: readonly string[];
  }>,
) {
  return {
    id: run.id,
    coordinationRecordId: run.coordinationRecordId,
    state: run.state,
    goal: run.goal,
    repositoryMode: run.repositoryMode,
    repositoryAssurance: run.repositoryAssurance,
    revision: run.revision,
    attemptIds: Array.from(run.attemptIds),
  };
}

function publicRecord(
  record: Readonly<{
    id: string;
    projectId: string;
    title: string;
    revision: number;
    runIds: readonly string[];
  }>,
) {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    revision: record.revision,
    runIds: Array.from(record.runIds),
  };
}

function resumeConfigurationUnavailable(): Result<never> {
  return {
    ok: false,
    error: {
      code: "RUN_RESUME_CONFIGURATION_REQUIRED",
      message: "Run resume configuration is unavailable.",
      retry: "REFRESH",
    },
  };
}

/**
 * The public surface is intentionally only a projection over ExecutionAuthority. Server-side
 * resolution supplies every runner/configuration authority fact; none are accepted from clients.
 */
export function createExecutionAuthorityRunOperations(
  dependencies: Dependencies,
): PublicRunOperations {
  return {
    async create(actor, request) {
      const resolved = await dependencies.resolveLaunch(actor, request);
      if (!resolved.ok) return resolved;
      const command = {
        kind: "LAUNCH_RUN",
        idempotencyKey: request.idempotencyKey,
        actor,
        projectId: request.projectId,
        coordination: request.coordination,
        goal: request.goal,
        ...resolved.value,
      } as LaunchRun;
      const result = await dependencies.authority.execute(command);
      return result.ok
        ? {
            ok: true,
            value: {
              kind: "CREATE_RUN",
              record: publicRecord(result.value.record),
              run: publicRun(result.value.run),
              attempt: {
                id: result.value.attempt.id,
                runId: result.value.attempt.runId,
                state: result.value.attempt.state,
                revision: result.value.attempt.revision,
              },
            },
          }
        : result;
    },
    async inspect(actor, request) {
      const query = { kind: "INSPECT_RUN", actor, runId: request.runId } as InspectRun;
      return (await dependencies.authority.query(query)) as never;
    },
    async cancel(actor, request) {
      const command = {
        kind: "CANCEL_RUN",
        actor,
        idempotencyKey: request.idempotencyKey,
        runId: request.runId,
        expectedRunRevision: request.expectedRunRevision,
        reason: "MEMBER_REQUEST",
      } as CancelRun;
      return (await dependencies.authority.execute(command)) as never;
    },
    async resume(actor, request) {
      const resolved = await dependencies.resolveLaunch(actor, request);
      if (!resolved.ok) return resumeConfigurationUnavailable();
      const command = {
        kind: "AUTHORIZE_ATTEMPT",
        actor,
        idempotencyKey: request.idempotencyKey,
        runId: request.runId,
        expectedRunRevision: request.expectedRunRevision,
        cause: { kind: "RESUME", checkpointId: request.checkpointId },
        execution: resolved.value.execution,
      } as AuthorizeAttempt;
      const result = await dependencies.authority.execute(command);
      return result.ok
        ? {
            ok: true,
            value: {
              kind: "RESUME_RUN",
              decision:
                result.value.decision.outcome === "AUTHORIZED"
                  ? {
                      outcome: "AUTHORIZED",
                      run: publicRun(result.value.decision.run),
                      attempt: {
                        id: result.value.decision.attempt.id,
                        runId: result.value.decision.attempt.runId,
                        state: result.value.decision.attempt.state,
                        revision: result.value.decision.attempt.revision,
                      },
                    }
                  : result.value.decision.outcome === "WAITING"
                    ? { ...result.value.decision, run: publicRun(result.value.decision.run) }
                    : result.value.decision,
            },
          }
        : result;
    },
    async evidence(actor, request) {
      const query = {
        kind: "INSPECT_EVIDENCE",
        actor,
        runId: request.runId,
        after: request.after,
        limit: request.limit,
      } as InspectEvidence;
      return (await dependencies.authority.query(query)) as never;
    },
  };
}
