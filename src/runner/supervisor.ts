import type { Result } from "../shared/contracts/result.ts";
import type {
  CustomLaunchProfile,
  ExecutionAdapter,
  ExecutionHost,
  HostProcess,
  RuntimeAdapter,
} from "./execution-contract.ts";

type WorktreeHandle = Readonly<{ id: string }>;
type Reservation = Readonly<{ reservationId: string; disposition: "NEW" | "RECONCILE" }>;

export type SupervisorLaunchRequest = Readonly<{
  runId: string;
  attemptId: string;
  assignmentDigest: string;
  worktreeKey: string;
  profileVersionId: string;
  expectedProfileFingerprint: string;
  runtime: RuntimeAdapter;
  host: "NATIVE" | "ORCA";
  interaction: "HEADLESS" | "INTERACTIVE";
  assurance: "ADVISORY" | "ENFORCED";
  instructions: string;
  maximumRuntimeSeconds: number;
  deadlineAt: number;
  dispatchPermit: string;
}>;

type Dependencies = Readonly<{
  profiles: Readonly<{
    resolve(profileVersionId: string, expectedFingerprint: string): Result<CustomLaunchProfile>;
  }>;
  processes: Readonly<{
    reserve(attemptId: string, assignmentDigest: string): Result<Reservation>;
    recordStarted(reservation: Reservation, identity: HostProcess): Result<void>;
  }>;
  worktrees: Readonly<{
    resolveRunWorktree(runId: string, worktreeKey: string): Promise<Result<WorktreeHandle>>;
  }>;
  environment: Readonly<{
    build(profile: CustomLaunchProfile): Result<Readonly<Record<string, string>>>;
  }>;
  enforcement: Readonly<{
    assurance: "ADVISORY" | "ENFORCED";
    activate(
      input: Readonly<{ worktree: WorktreeHandle; assurance: "ADVISORY" | "ENFORCED" }>,
    ): Promise<Result<Readonly<{ sessionId: string }>>>;
    revoke(sessionId: string): Promise<Result<void>>;
  }>;
  permits: Readonly<{
    consume(
      input: Readonly<{ permit: string; attemptId: string; assignmentDigest: string }>,
    ): Promise<Result<Readonly<{ consumed: true }>>>;
  }>;
  adapters: Partial<Record<RuntimeAdapter, ExecutionAdapter>>;
  hosts: Partial<Record<"NATIVE" | "ORCA", ExecutionHost>>;
}>;

function failure<T>(
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" = "NEVER",
): Result<T> {
  return { ok: false, error: { code, message, retry } };
}

function validEnvironment(environment: Readonly<Record<string, string>>): boolean {
  const allowed = new Set(["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"]);
  return (
    Object.keys(environment).length <= allowed.size &&
    Object.entries(environment).every(
      ([key, value]) =>
        allowed.has(key) && value.length <= 4_096 && !value.includes("\0") && !/[\r\n]/.test(value),
    )
  );
}

export function createRunnerSupervisor(dependencies: Dependencies) {
  return {
    async launch(
      request: SupervisorLaunchRequest,
    ): Promise<Result<Readonly<{ process: HostProcess }>>> {
      if (request.assurance !== "ADVISORY" || dependencies.enforcement.assurance !== "ADVISORY") {
        return failure("ASSURANCE_UNAVAILABLE", "Requested repository assurance is unavailable.");
      }
      const profile = dependencies.profiles.resolve(
        request.profileVersionId,
        request.expectedProfileFingerprint,
      );
      if (!profile.ok) return profile;
      if (profile.value.adapter !== request.runtime) {
        return failure("PROFILE_UNAVAILABLE", "Execution profile is unavailable.");
      }
      const adapter = dependencies.adapters[request.runtime];
      const host = dependencies.hosts[request.host];
      if (!adapter || !host) {
        return failure("CAPABILITY_UNSUPPORTED", "Execution capability is unsupported.");
      }
      const prepared = await adapter.prepare({
        profile: profile.value,
        profileVersionId: request.profileVersionId,
        expectedFingerprint: request.expectedProfileFingerprint,
        interaction: request.interaction,
        instructions: request.instructions,
        maximumRuntimeSeconds: request.maximumRuntimeSeconds,
      });
      if (!prepared.ok) return prepared;
      const worktree = await dependencies.worktrees.resolveRunWorktree(
        request.runId,
        request.worktreeKey,
      );
      if (!worktree.ok) return worktree;
      const environment = dependencies.environment.build(profile.value);
      if (!environment.ok) return environment;
      if (!validEnvironment(environment.value)) {
        return failure("ENVIRONMENT_POLICY_DENIED", "Execution environment is invalid.");
      }
      const enforcement = await dependencies.enforcement.activate({
        worktree: worktree.value,
        assurance: request.assurance,
      });
      if (!enforcement.ok) return enforcement;
      const reservation = dependencies.processes.reserve(
        request.attemptId,
        request.assignmentDigest,
      );
      if (!reservation.ok) {
        await dependencies.enforcement.revoke(enforcement.value.sessionId);
        return reservation;
      }
      if (reservation.value.disposition !== "NEW") {
        await dependencies.enforcement.revoke(enforcement.value.sessionId);
        return failure(
          "PROCESS_RECONCILIATION_REQUIRED",
          "Existing local process must be reconciled.",
          "REFRESH",
        );
      }
      const permit = await dependencies.permits.consume({
        permit: request.dispatchPermit,
        attemptId: request.attemptId,
        assignmentDigest: request.assignmentDigest,
      });
      if (!permit.ok) {
        await dependencies.enforcement.revoke(enforcement.value.sessionId);
        return permit;
      }
      const started = await host.start({
        attemptId: request.attemptId,
        worktree: worktree.value,
        invocation: {
          argv: prepared.value.invocation.argv,
          prompt: prepared.value.prompt,
        },
        environment: environment.value,
        interaction: request.interaction,
        assurance: request.assurance,
        deadlineAt: request.deadlineAt,
      });
      if (!started.ok) {
        await dependencies.enforcement.revoke(enforcement.value.sessionId);
        return started;
      }
      const recorded = dependencies.processes.recordStarted(reservation.value, started.value);
      if (!recorded.ok) {
        await host.cancel(started.value);
        await dependencies.enforcement.revoke(enforcement.value.sessionId);
        return failure("PROCESS_STATE_FAILED", "Local process state could not be recorded.");
      }
      return { ok: true, value: { process: started.value } };
    },
  };
}
