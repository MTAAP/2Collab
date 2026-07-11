import { describe, expect, test } from "bun:test";
import { createExecutionAuthorityRunOperations } from "../../../src/server/modules/public-surface/run-operations.ts";

const actor = {
  kind: "MEMBER" as const,
  memberId: "member_1" as never,
  sessionId: "session_1" as never,
  sessionProof: "verified-request-proof-with-at-least-thirty-two-bytes",
};

describe("database-backed public run operations", () => {
  test("projects public operations onto the one ExecutionAuthority without exposing authority fields", async () => {
    const calls: unknown[] = [];
    const run = {
      id: "run_1",
      coordinationRecordId: "record_1",
      state: "QUEUED" as const,
      goal: "Run",
      repositoryMode: "INSPECT_ONLY" as const,
      repositoryAssurance: "ADVISORY" as const,
      revision: 1,
      attemptIds: ["attempt_1"],
    };
    const authority = {
      preview: async () => ({}) as never,
      execute: async (command: { kind: string }) => {
        calls.push(command);
        if (command.kind === "LAUNCH_RUN")
          return {
            ok: true as const,
            value: {
              kind: "LAUNCH_RUN" as const,
              record: {
                id: "record_1",
                projectId: "project_1",
                title: "Run",
                revision: 1,
                runIds: ["run_1"],
              },
              run,
              attempt: { id: "attempt_1", runId: "run_1", state: "PENDING" as const, revision: 1 },
              dispatch: {
                deliveryId: "delivery_1",
                runnerId: "runner_1",
                runnerEpoch: 1,
                semanticDigest: "a".repeat(64),
                queuedAt: 1,
              },
            },
          };
        return {
          ok: true as const,
          value: {
            kind: "CANCEL_RUN" as const,
            run: { ...run, state: "CANCELLED" as const, revision: 2 },
            termination: { kind: "NO_ACTIVE_ATTEMPT" as const },
          },
        };
      },
      query: async (query: { kind: string }) => {
        calls.push(query);
        return query.kind === "INSPECT_EVIDENCE"
          ? { ok: true as const, value: { kind: "INSPECT_EVIDENCE" as const, evidence: [] } }
          : { ok: true as const, value: { kind: "INSPECT_RUN" as const, run } };
      },
    };
    const operations = createExecutionAuthorityRunOperations({
      authority: authority as never,
      resolveLaunch: async () =>
        ({
          ok: true,
          value: {
            repository: {
              repositoryId: "repository_1",
              mode: "INSPECT_ONLY",
              assurance: "ADVISORY",
              base: { kind: "EXACT", commitSha: "a".repeat(40) },
            },
            execution: {
              runnerId: "runner_1",
              expectedRunnerEpoch: 1,
              projectMappingRevision: 1,
              profileVersionId: "profile_1",
              expectedProfileVersion: 1,
              host: "NATIVE",
              interaction: "HEADLESS",
            },
            effectiveConfiguration: {
              configurationId: "configuration_1",
              version: 1,
              digest: "b".repeat(64),
            },
          },
        }) as never,
    });
    const request = {
      idempotencyKey: "launch_1",
      projectId: "project_1",
      coordination: { kind: "NEW" as const, title: "Run", sourceRefs: [] },
      goal: "Run",
      repository: { repositoryId: "repository_1" },
      preset: { presetId: "preset_1", presetVersion: 1 },
    };
    const created = await operations.create(actor, request);
    expect(created.ok && created.value.kind).toBe("CREATE_RUN");
    expect(JSON.stringify(created)).not.toContain("runner_1");
    expect(calls[0]).toMatchObject({
      kind: "LAUNCH_RUN",
      actor,
      execution: { runnerId: "runner_1" },
    });
    expect(await operations.inspect(actor, { runId: "run_1" })).toMatchObject({
      ok: true,
      value: { kind: "INSPECT_RUN" },
    });
    expect(await operations.evidence(actor, { runId: "run_1", limit: 50 })).toMatchObject({
      ok: true,
      value: { kind: "INSPECT_EVIDENCE" },
    });
    expect(
      await operations.cancel(actor, {
        idempotencyKey: "cancel_1",
        runId: "run_1",
        expectedRunRevision: 1,
      }),
    ).toMatchObject({ ok: true, value: { kind: "CANCEL_RUN" } });
  });

  test("resume fails stably when no server-side configuration can be resolved", async () => {
    const operations = createExecutionAuthorityRunOperations({
      authority: {
        preview: async () => ({}) as never,
        execute: async () => {
          throw new Error("not called");
        },
        query: async () => {
          throw new Error("not called");
        },
      } as never,
      resolveLaunch: async () => ({
        ok: false,
        error: { code: "PRESET_NOT_FOUND", message: "Preset not found.", retry: "NEVER" },
      }),
    });
    expect(
      await operations.resume(actor, {
        idempotencyKey: "resume_1",
        runId: "run_1",
        expectedRunRevision: 2,
        checkpointId: "checkpoint_1",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "RUN_RESUME_CONFIGURATION_REQUIRED",
        message: "Run resume configuration is unavailable.",
        retry: "REFRESH",
      },
    });
  });
});
