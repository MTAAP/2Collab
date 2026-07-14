import type { ExecutionAuthority } from "../../../src/shared/contracts/execution-authority.ts";
import type { InspectRun, LaunchRun } from "../../../src/shared/contracts/commands.ts";
import type {
  AgentRunId,
  CommitSha,
  ConnectedRepositoryId,
  CoordinationRecordId,
  CustomLaunchProfileVersionId,
  MemberId,
  ProjectId,
  RegisteredRunnerId,
  Sha256,
} from "../../../src/shared/contracts/ids.ts";
import type { StartWorkflow } from "../../../src/server/modules/workflows/contract.ts";
import { validDefinition } from "./valid.ts";

export function createWorkflowAuthority() {
  const commands: unknown[] = [];
  const queries: unknown[] = [];
  let nextRun = 1;
  const authority = {
    preview: async () => ({ evaluatedAt: 0, eligibleTargets: [], requirements: [] }),
    execute: async (value: unknown) => {
      const command = value as LaunchRun;
      if (command.coordination.kind !== "EXISTING")
        throw new Error("EXPECTED_EXISTING_COORDINATION");
      commands.push(command);
      const runId = `run_${nextRun++}` as AgentRunId;
      return {
        ok: true as const,
        value: {
          kind: "LAUNCH_RUN" as const,
          record: {
            id: command.coordination.coordinationRecordId,
            projectId: command.projectId,
            title: "Workflow",
            revision: command.coordination.expectedRevision + 1,
            runIds: [runId],
          },
          run: {
            id: runId,
            coordinationRecordId: command.coordination.coordinationRecordId,
            state: "QUEUED" as const,
            goal: command.goal,
            repositoryMode: command.repository.mode,
            repositoryAssurance: command.repository.assurance,
            revision: 1,
            attemptIds: [],
          },
          attempt: {
            id: `attempt_${nextRun}`,
            runId,
            runnerId: command.execution.runnerId,
            state: "PENDING" as const,
            revision: 1,
          },
          dispatch: {
            outboxId: `outbox_${nextRun}`,
            runnerId: command.execution.runnerId,
            attemptId: `attempt_${nextRun}`,
            assignmentDigest: "a".repeat(64),
          },
        },
      };
    },
    query: async (value: unknown) => {
      const query = value as InspectRun;
      queries.push(query);
      return {
        ok: true as const,
        value: {
          kind: "INSPECT_RUN" as const,
          run: {
            id: query.runId,
            coordinationRecordId: "coordination_1" as CoordinationRecordId,
            state: "COMPLETED" as const,
            goal: "Completed workflow step",
            repositoryMode: "INSPECT_ONLY" as const,
            repositoryAssurance: "ADVISORY" as const,
            revision: 2,
            attemptIds: [],
          },
        },
      };
    },
  } as unknown as ExecutionAuthority;
  return { authority, commands, queries };
}

const launch = (mode: "MUTATING" | "INSPECT_ONLY") => ({
  projectId: "project_1" as ProjectId,
  goal: `${mode} workflow step`,
  repository: {
    repositoryId: "repository_1" as ConnectedRepositoryId,
    mode,
    assurance: "ADVISORY" as const,
    base: { kind: "EXACT" as const, commitSha: "a".repeat(40) as CommitSha },
  },
  execution: {
    runnerId: "runner_1" as RegisteredRunnerId,
    expectedRunnerEpoch: 1,
    projectMappingRevision: 1,
    profileVersionId: "profile_1" as CustomLaunchProfileVersionId,
    expectedProfileVersion: 1,
    host: "NATIVE" as const,
    interaction: "HEADLESS" as const,
  },
  effectiveConfiguration: {
    configurationId: "configuration_1",
    version: 1,
    digest: "b".repeat(64) as Sha256,
  },
});

export const startCommand = {
  idempotencyKey: "workflow_start_1",
  workflowExecutionId: "workflow_1",
  coordinationRecordId: "coordination_1" as CoordinationRecordId,
  coordinationRevision: 1,
  templateVersionId: "workflow_template_1",
  presetVersionId: "workflow_preset_1",
  definition: validDefinition,
  schedulerActor: {
    kind: "SCHEDULER",
    originalDispatcherId: "member_1" as MemberId,
    workflowExecutionId: "workflow_1" as never,
  },
  launches: {
    implement: launch("MUTATING"),
    review: launch("INSPECT_ONLY"),
  },
} satisfies StartWorkflow;
