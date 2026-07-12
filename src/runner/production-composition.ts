import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createNativeExecutionHost } from "./adapters/host/native.ts";
import { createNativeProcessPort } from "./adapters/host/native-process.ts";
import { createClaudeExecutionAdapter } from "./adapters/runtime/claude.ts";
import { createCodexExecutionAdapter } from "./adapters/runtime/codex.ts";
import { createTrustedHostEnforcement } from "./adapters/enforcement/trusted-host.ts";
import { createRunnerEnvironmentBuilder } from "./environment.ts";
import type { HostProcess } from "./execution-contract.ts";
import { assembleEffectiveInstructions } from "./instruction-assembly.ts";
import type { LocalRunnerConfiguration, LocalRunnerProjectMapping } from "./local-configuration.ts";
import { createLocalProcessRegistry } from "./process-state.ts";
import { createLocalProfileRegistry } from "./profiles.ts";
import { createWorktreeManager } from "./repository/worktrees.ts";
import type { ServerEnvelope, RunnerEnvelope } from "../shared/contracts/protocol.ts";
import type { Result } from "../shared/contracts/result.ts";
import { createRunnerSupervisor } from "./supervisor.ts";

type Launch = Extract<ServerEnvelope["body"], Readonly<{ kind: "LAUNCH_ATTEMPT" }>>;
type Send = (body: RunnerEnvelope["body"]) => Result<Readonly<{ queued: boolean }>>;

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function createProductionRunnerExecution(
  input: Readonly<{
    database: Database;
    configuration: LocalRunnerConfiguration;
    managedRoot: string;
    runnerId: string;
    ownerMemberId: string;
    home: string;
    path: string;
    send: Send;
    consumePermit(
      request: Readonly<{
        permit: string;
        attemptId: string;
        assignmentDigest: string;
      }>,
    ): Promise<Result<Readonly<{ consumed: true }>>>;
    clock?: () => number;
    id?: (kind: string) => string;
  }>,
) {
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1_000));
  const id = input.id ?? ((kind: string) => `${kind}_${Bun.randomUUIDv7().replaceAll("-", "")}`);
  mkdirSync(input.managedRoot, { recursive: true, mode: 0o700 });
  const worktreePaths = new Map<string, string>();
  const launches = new Map<string, Launch>();
  const attemptProcesses = new Map<string, HostProcess>();
  const revisions = new Map<string, { run: number; attempt: number }>();
  const processRegistry = createLocalProcessRegistry(input.database, clock, () =>
    id("reservation"),
  );

  const sendAttemptEvent = (
    launch: Launch,
    event: Extract<RunnerEnvelope["body"], { kind: "ATTEMPT_EVENT" }>["payload"]["event"],
  ): Result<Readonly<{ queued: boolean }>> => {
    const revision = revisions.get(launch.attemptId) ?? {
      run: launch.runRevision ?? 1,
      attempt: launch.attemptRevision ?? 1,
    };
    const sent = input.send({
      kind: "ATTEMPT_EVENT",
      eventId: id("event"),
      payload: {
        runId: launch.runId,
        expectedRunRevision: revision.run,
        attemptId: launch.attemptId,
        expectedAttemptRevision: revision.attempt,
        event,
      },
    });
    if (sent.ok) {
      revisions.set(launch.attemptId, {
        run: revision.run + (event.kind === "PROCESS_STARTED" ? 1 : 0),
        attempt: revision.attempt + 1,
      });
    }
    return sent;
  };

  const native = createNativeExecutionHost(
    createNativeProcessPort({
      resolveWorktree: (worktreeId) => worktreePaths.get(worktreeId),
      clock,
      onExit: ({ attemptId, exitCode, cancelled }) => {
        processRegistry.recordExited(attemptId, exitCode);
        const launch = launches.get(attemptId);
        if (!launch) return;
        sendAttemptEvent(
          launch,
          cancelled
            ? {
                kind: "CANCELLED",
                observedAt: clock(),
                confirmation: "PROCESS_TERMINATED",
              }
            : { kind: "PROCESS_EXITED", observedAt: clock(), exitCode },
        );
        attemptProcesses.delete(attemptId);
      },
    }),
  );
  const manager = (worktreeIdentity: string) =>
    createWorktreeManager({
      database: input.database,
      managedRoot: input.managedRoot,
      clock,
      id: (kind) => (kind === "worktree" ? worktreeIdentity : id(kind)),
      pinRun: async ({ expectedRunRevision }) => ({
        ok: true,
        value: { runRevision: expectedRunRevision },
      }),
      authorizations: {
        verify: async () =>
          failure("WORKTREE_AUTHORIZATION_UNAVAILABLE", "Worktree authorization is unavailable."),
        consume: async () =>
          failure("WORKTREE_AUTHORIZATION_UNAVAILABLE", "Worktree authorization is unavailable."),
      },
    });
  const supervisor = createRunnerSupervisor({
    profiles: createLocalProfileRegistry(input.database, clock),
    processes: processRegistry,
    worktrees: {
      async resolveRunWorktree(runId) {
        const launch = launches.get(runId);
        if (
          !launch?.projectId ||
          !launch.repositoryId ||
          !launch.baseBranch ||
          !launch.worktreeIdentity
        )
          return failure("RUNNER_LAUNCH_INCOMPLETE", "Runner launch metadata is incomplete.");
        let mapping: LocalRunnerProjectMapping;
        try {
          mapping = input.configuration.resolveProject(
            launch.projectId,
            launch.projectMappingRevision,
          );
        } catch {
          return failure(
            "RUNNER_PROJECT_MAPPING_UNAVAILABLE",
            "Runner project mapping is unavailable.",
          );
        }
        if (
          mapping.projectId !== launch.projectId ||
          mapping.repositoryId !== launch.repositoryId ||
          mapping.baseBranch !== launch.baseBranch
        )
          return failure("RUNNER_PROJECT_MAPPING_MISMATCH", "Runner project mapping changed.");
        const created = await manager(launch.worktreeIdentity).createOrReuse({
          runId: launch.runId,
          expectedRunRevision: launch.runRevision ?? 1,
          projectId: launch.projectId,
          repositoryId: launch.repositoryId,
          runnerId: input.runnerId,
          ownerMemberId: input.ownerMemberId,
          repositoryRoot: mapping.checkout,
          baseCommit: launch.baseRevision,
          branch: launch.intendedBranch ?? `collab/${launch.runId}`,
          remoteName: mapping.remoteName,
          remoteIdentity: mapping.remoteIdentity,
          remoteRef: mapping.remoteRef,
        });
        if (created.ok && created.value.id !== launch.worktreeIdentity)
          return failure("WORKTREE_ASSIGNMENT_CONFLICT", "Managed worktree assignment changed.");
        if (created.ok)
          worktreePaths.set(created.value.id, join(input.managedRoot, created.value.id));
        return created;
      },
    },
    environment: createRunnerEnvironmentBuilder({
      base: {
        HOME: input.home,
        PATH: input.path,
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      },
      allowedNames: [],
      credentials: { resolve: () => undefined },
    }),
    enforcement: createTrustedHostEnforcement({ id: () => id("enforcement") }),
    permits: { consume: input.consumePermit },
    adapters: {
      CODEX: createCodexExecutionAdapter(),
      CLAUDE: createClaudeExecutionAdapter(),
    },
    hosts: { NATIVE: native },
    clock,
    output: {
      send: async (body) => {
        const sent = input.send(body);
        if (!sent.ok) throw new Error(sent.error.code);
      },
    },
  });

  return {
    async launch(launch: Launch): Promise<Result<Readonly<{ started: true }>>> {
      if (
        !launch.projectId ||
        !launch.repositoryId ||
        !launch.runRevision ||
        !launch.attemptRevision ||
        !launch.worktreeIdentity ||
        !launch.baseBranch ||
        launch.policyExpiresAt <= clock()
      )
        return failure("RUNNER_LAUNCH_INCOMPLETE", "Runner launch metadata is incomplete.");
      const assembled = assembleEffectiveInstructions({
        instructions: launch.instructions,
        bootstrap: launch.bootstrap,
      });
      if (!assembled.ok) return assembled;
      launches.set(launch.runId, launch);
      launches.set(launch.attemptId, launch);
      const profile = createLocalProfileRegistry(input.database, clock).resolve(
        launch.profileVersionId,
        launch.profileFingerprint,
      );
      if (!profile.ok) return profile;
      const maximumRuntimeSeconds = Math.max(
        1,
        Math.min(7 * 24 * 60 * 60, launch.deadlineAt - clock()),
      );
      const result = await supervisor.launch({
        runId: launch.runId,
        attemptId: launch.attemptId,
        assignmentDigest: launch.semanticDigest,
        worktreeKey: launch.worktreeIdentity,
        profileVersionId: launch.profileVersionId,
        expectedProfileFingerprint: launch.profileFingerprint,
        runtime: profile.value.adapter,
        host: launch.host,
        interaction: launch.interaction,
        assurance: launch.repositoryAssurance,
        instructions: assembled.value,
        maximumRuntimeSeconds,
        deadlineAt: launch.deadlineAt,
        dispatchPermit: launch.dispatchPermit,
      });
      if (!result.ok) {
        sendAttemptEvent(launch, {
          kind: "FAILED_TO_START",
          observedAt: clock(),
          code: result.error.code,
        });
        return result;
      }
      attemptProcesses.set(launch.attemptId, result.value.process);
      const event = sendAttemptEvent(launch, {
        kind: "PROCESS_STARTED",
        observedAt: clock(),
      });
      if (!event.ok) {
        await native.cancel(result.value.process);
        return event;
      }
      return { ok: true, value: { started: true } };
    },
    async cancel(
      attemptId: string,
      reason: "CANCELLATION" | "REVOCATION" | "DEADLINE" | "SHUTDOWN",
    ): Promise<Result<Readonly<{ requested: boolean }>>> {
      const process = attemptProcesses.get(attemptId);
      const launch = launches.get(attemptId);
      if (!process || !launch) return failure("PROCESS_NOT_FOUND", "Local process was not found.");
      const requested = await native.cancel(process);
      if (!requested.ok) return requested;
      const event = sendAttemptEvent(launch, {
        kind: "TERMINATION_REQUESTED",
        reason:
          reason === "SHUTDOWN" ? "CANCELLATION" : reason === "DEADLINE" ? "DEADLINE" : reason,
        observedAt: clock(),
      });
      return event.ok ? requested : event;
    },
  };
}
