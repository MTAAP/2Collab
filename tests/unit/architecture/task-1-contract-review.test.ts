import { describe, expect, expectTypeOf, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type {
  AuthorizeAttempt,
  CommandResultFor,
  InspectRun,
  LaunchRun,
  QueryResultFor,
} from "../../../src/shared/contracts/commands.ts";
import { CollabCommandSchema } from "../../../src/shared/contracts/commands.ts";
import { CommitShaSchema } from "../../../src/shared/contracts/ids.ts";
import { RunnerFrameSchema } from "../../../src/shared/contracts/protocol.ts";
import { DomainErrorSchema } from "../../../src/shared/contracts/result.ts";

const memberActor = {
  kind: "MEMBER",
  memberId: "member_1",
  sessionId: "session_1",
  sessionProof: "proof_value_with_at_least_thirty_two_bytes",
} as const;
const commandBase = { idempotencyKey: "idem_1", actor: memberActor } as const;
const fullSha1 = "a".repeat(40);
const fullSha256 = "b".repeat(64);
const digest = "c".repeat(64);

function launchCommand(intendedBranch = "feature/contracts") {
  return {
    ...commandBase,
    kind: "LAUNCH_RUN",
    projectId: "project_1",
    coordination: { kind: "NEW", title: "Contract review", sourceRefs: [] },
    goal: "Review the contracts",
    repository: {
      repositoryId: "repository_1",
      mode: "MUTATING",
      assurance: "ADVISORY",
      base: { kind: "EXACT", commitSha: fullSha1 },
      intendedBranch,
    },
    execution: {
      runnerId: "runner_1",
      expectedRunnerEpoch: 1,
      projectMappingRevision: 1,
      profileVersionId: "profile_1",
      host: "NATIVE",
      interaction: "HEADLESS",
    },
    effectiveConfiguration: { configurationId: "config_1", version: 1, digest },
  };
}

function authorizeOperation(operation: Record<string, unknown>) {
  return {
    ...commandBase,
    kind: "AUTHORIZE_OPERATION",
    sessionId: "session_authority_1",
    sessionFence: 1,
    operation,
  };
}

describe("reviewed shared contracts", () => {
  test("accepts only full lowercase SHA-1 or SHA-256 commit identifiers", () => {
    expect(CommitShaSchema.safeParse(fullSha1).success).toBe(true);
    expect(CommitShaSchema.safeParse(fullSha256).success).toBe(true);
    expect(CommitShaSchema.safeParse("abcdef0").success).toBe(false);
    expect(CommitShaSchema.safeParse("A".repeat(40)).success).toBe(false);
    expect(CommitShaSchema.safeParse("a".repeat(41)).success).toBe(false);
  });

  test("bounds error detail keys and entry count and rejects unknown fields", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`detail_${index}`, index]),
    );
    expect(
      DomainErrorSchema.safeParse({
        code: "REVISION_CONFLICT",
        message: "Refresh required.",
        retry: "REFRESH",
        details: tooMany,
      }).success,
    ).toBe(false);
    expect(
      DomainErrorSchema.safeParse({
        code: "REVISION_CONFLICT",
        message: "Refresh required.",
        retry: "REFRESH",
        details: { ["x".repeat(65)]: true },
      }).success,
    ).toBe(false);
    expect(
      DomainErrorSchema.safeParse({
        code: "REVISION_CONFLICT",
        message: "Refresh required.",
        retry: "REFRESH",
        unsafe: "secret",
      }).success,
    ).toBe(false);
  });

  test("validates normalized non-option-like intended branches and remote refs", () => {
    expect(CollabCommandSchema.safeParse(launchCommand()).success).toBe(true);
    expect(CollabCommandSchema.safeParse(launchCommand("-force")).success).toBe(false);
    expect(CollabCommandSchema.safeParse(launchCommand("feature/../escape")).success).toBe(false);
    expect(
      CollabCommandSchema.safeParse(
        authorizeOperation({
          kind: "PUBLISH_GIT_REFERENCE",
          expectedHead: fullSha1,
          remoteRef: "refs/heads/feature/contracts",
        }),
      ).success,
    ).toBe(true);
    expect(
      CollabCommandSchema.safeParse(
        authorizeOperation({
          kind: "PUBLISH_GIT_REFERENCE",
          expectedHead: fullSha1,
          remoteRef: "-force",
        }),
      ).success,
    ).toBe(false);
  });

  test("maps launch, attempt, and query results without a public permit token", async () => {
    const module = await import("../../../src/shared/contracts/commands.ts");
    expectTypeOf<CommandResultFor<LaunchRun>>().toMatchTypeOf<{
      kind: "LAUNCH_RUN";
      dispatch: { state: "QUEUED" };
    }>();
    expectTypeOf<CommandResultFor<AuthorizeAttempt>>().toMatchTypeOf<{
      kind: "AUTHORIZE_ATTEMPT";
      dispatch: { state: "QUEUED" };
    }>();
    expectTypeOf<QueryResultFor<InspectRun>>().toMatchTypeOf<{
      kind: "INSPECT_RUN";
    }>();
    expect("CommandResultSchema" in module).toBe(true);
    const schema = module.CommandResultSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    const safe = {
      kind: "LAUNCH_RUN",
      record: {
        id: "record_1",
        projectId: "project_1",
        title: "Contract review",
        revision: 1,
        runIds: ["run_1"],
      },
      run: {
        id: "run_1",
        coordinationRecordId: "record_1",
        state: "QUEUED",
        goal: "Review the contracts",
        repositoryMode: "MUTATING",
        repositoryAssurance: "ADVISORY",
        revision: 1,
        attemptIds: ["attempt_1"],
      },
      attempt: {
        id: "attempt_1",
        runId: "run_1",
        runnerId: "runner_1",
        state: "PENDING",
        revision: 1,
      },
      dispatch: {
        state: "QUEUED",
        runnerId: "runner_1",
        attemptId: "attempt_1",
        expiresAt: 30_000,
      },
    };
    expect(schema.safeParse(safe).success).toBe(true);
    expect(
      schema.safeParse({ ...safe, dispatch: { ...safe.dispatch, token: "signed-secret" } }).success,
    ).toBe(false);
    const publicContractText = await Promise.all(
      ["ids.ts", "runs.ts", "commands.ts"].map((name) =>
        readFile(`src/shared/contracts/${name}`, "utf8"),
      ),
    );
    expect(publicContractText.join("\n")).not.toContain("DispatchPermit");
    const authorityModule = await import("../../../src/shared/contracts/execution-authority.ts");
    expect("CommandResultSchema" in authorityModule).toBe(true);
  });

  test("accepts the closed reconciliation command", () => {
    expect(
      CollabCommandSchema.safeParse({
        ...commandBase,
        kind: "RECONCILE_OBSERVATION",
        runId: "run_1",
        expectedRunRevision: 2,
        observation: {
          kind: "SOURCE_REVISION",
          connectorId: "connector_1",
          sourceKind: "GITHUB_ISSUE",
          sourceItemId: "42",
          availability: "AVAILABLE",
          observedRevision: "etag-2",
          observedAt: 1_000,
        },
      }).success,
    ).toBe(true);
  });

  test("uses the canonical closed GitHub and Outline operation kinds", () => {
    const githubKinds = [
      "CREATE_ISSUE",
      "EDIT_ISSUE",
      "ADD_COMMENT",
      "SET_LABELS",
      "SET_ASSIGNEES",
      "SET_MILESTONE",
      "SET_ISSUE_STATE",
      "CREATE_MILESTONE",
      "EDIT_MILESTONE",
      "ADD_PROJECT_ITEM",
      "REMOVE_PROJECT_ITEM",
      "SET_PROJECT_FIELD",
      "MOVE_PROJECT_ITEM",
    ];
    for (const mutation of githubKinds) {
      expect(
        CollabCommandSchema.safeParse(
          authorizeOperation({
            kind: "MUTATE_GITHUB",
            projectId: "project_1",
            connectorId: "connector_1",
            connectorEpoch: 1,
            resourceId: "resource_1",
            precondition: {
              kind: "EXACT_REVISION",
              sourceRevision: "revision_1",
              comparableDigest: digest,
            },
            actionDigest: digest,
            mutation,
          }),
        ).success,
      ).toBe(true);
    }

    for (const mutation of [
      "CREATE_DOCUMENT_AS_MEMBER",
      "EDIT_DOCUMENT_AS_MEMBER",
      "EDIT_DOCUMENT_AS_BOT",
      "APPLY_PROPOSAL_AS_MEMBER",
      "PROMOTE_WORKING_DOCUMENT",
      "ARCHIVE_WORKING_DOCUMENT",
    ]) {
      expect(
        CollabCommandSchema.safeParse(
          authorizeOperation({
            kind: "MUTATE_OUTLINE",
            projectId: "project_1",
            connectorId: "connector_1",
            connectorEpoch: 1,
            documentId: "document_1",
            precondition: {
              kind: "EXACT_REVISION",
              sourceRevision: "revision_1",
              comparableDigest: digest,
            },
            actionDigest: digest,
            mutation,
          }),
        ).success,
      ).toBe(true);
    }
    for (const mutation of ["ISSUE_COMMENT", "ARCHIVE_DOCUMENT"]) {
      expect(
        CollabCommandSchema.safeParse(
          authorizeOperation({
            kind: "MUTATE_OUTLINE",
            projectId: "project_1",
            connectorId: "connector_1",
            connectorEpoch: 1,
            documentId: "document_1",
            precondition: {
              kind: "EXACT_REVISION",
              sourceRevision: "revision_1",
              comparableDigest: digest,
            },
            actionDigest: digest,
            mutation,
          }),
        ).success,
      ).toBe(false);
    }
  });

  test("accepts closed typed evidence and rejects generic or prohibited payloads", () => {
    const command = {
      ...commandBase,
      kind: "RECORD_EVIDENCE",
      runId: "run_1",
      expectedRunRevision: 1,
      attemptId: "attempt_1",
      evidence: {
        kind: "PUBLISHED_GIT_REFERENCE",
        remoteIdentity: "origin",
        remoteRef: "refs/heads/feature/contracts",
        commitSha: fullSha1,
        verifiedAt: 1_000,
      },
    };
    expect(CollabCommandSchema.safeParse(command).success).toBe(true);
    expect(
      CollabCommandSchema.safeParse({
        ...command,
        evidence: {
          kind: "CHANGED_PATHS",
          baseCommit: fullSha1,
          observedAt: 1_000,
          paths: ["src/shared/contracts/result.ts"],
          truncated: false,
        },
      }).success,
    ).toBe(true);
    expect(
      CollabCommandSchema.safeParse({
        ...command,
        evidence: {
          kind: "CHANGED_PATHS",
          baseCommit: fullSha1,
          observedAt: 1_000,
          paths: ["/Users/person/private.ts"],
          truncated: false,
        },
      }).success,
    ).toBe(false);
    expect(
      CollabCommandSchema.safeParse({
        ...command,
        evidence: {
          kind: "CHANGED_PATHS",
          baseCommit: fullSha1,
          observedAt: 1_000,
          paths: ["C:/Users/person/private.ts"],
          truncated: false,
        },
      }).success,
    ).toBe(false);
    for (const prohibited of [
      "rawDiff",
      "sourceBody",
      "transcript",
      "environment",
      "credential",
      "absolutePath",
    ]) {
      expect(
        CollabCommandSchema.safeParse({
          ...command,
          evidence: { ...command.evidence, [prohibited]: "secret" },
        }).success,
      ).toBe(false);
    }
    expect(
      CollabCommandSchema.safeParse({
        ...commandBase,
        kind: "RECORD_EVIDENCE",
        runId: "run_1",
        expectedRunRevision: 1,
        evidenceKind: "PROGRESS",
        summary: "generic",
      }).success,
    ).toBe(false);
  });

  test("requires gate key, exact repository revision, and approved fingerprint", () => {
    const frame = {
      messageId: "message_1",
      runnerId: "runner_1",
      runId: "run_1",
      issuedAt: 1_000,
      expiresAt: 2_000,
      operation: {
        kind: "EXECUTE_LOCAL_GATE",
        gateEvaluationId: "gate_evaluation_1",
        gateKey: "unit_tests",
        repositoryRevision: fullSha1,
        manifestFingerprint: digest,
      },
    };
    expect(RunnerFrameSchema.safeParse(frame).success).toBe(true);
    expect(
      RunnerFrameSchema.safeParse({
        ...frame,
        operation: { ...frame.operation, repositoryRevision: "abcdef0" },
      }).success,
    ).toBe(false);
    const { gateKey: _gateKey, ...withoutGateKey } = frame.operation;
    expect(RunnerFrameSchema.safeParse({ ...frame, operation: withoutGateKey }).success).toBe(
      false,
    );
  });

  test("models cancellation request separately from confirmed terminal evidence", async () => {
    const base = {
      ...commandBase,
      kind: "ACCEPT_ATTEMPT_EVENT",
      runId: "run_1",
      expectedRunRevision: 1,
      attemptId: "attempt_1",
      expectedAttemptRevision: 1,
    };
    expect(
      CollabCommandSchema.safeParse({
        ...base,
        event: {
          kind: "TERMINATION_REQUESTED",
          reason: "CANCELLATION",
          observedAt: 1_000,
        },
      }).success,
    ).toBe(true);
    expect(
      CollabCommandSchema.safeParse({
        ...base,
        event: { kind: "CANCELLED", observedAt: 2_000, confirmed: false },
      }).success,
    ).toBe(false);
    expect(
      CollabCommandSchema.safeParse({
        ...base,
        event: {
          kind: "CANCELLED",
          observedAt: 2_000,
          confirmation: "PROCESS_TERMINATED",
        },
      }).success,
    ).toBe(true);
    expect(
      CollabCommandSchema.safeParse({
        ...base,
        event: { kind: "LOST", observedAt: 91_000 },
      }).success,
    ).toBe(true);

    const resultModule = await import("../../../src/shared/contracts/commands.ts");
    const cancelledRun = {
      id: "run_1",
      coordinationRecordId: "record_1",
      state: "RUNNING",
      goal: "Review contracts",
      repositoryMode: "MUTATING",
      repositoryAssurance: "ADVISORY",
      revision: 2,
      attemptIds: ["attempt_1"],
    };
    expect(
      resultModule.CommandResultSchema.safeParse({
        kind: "CANCEL_RUN",
        run: cancelledRun,
        termination: {
          kind: "REQUEST_TERMINATION",
          request: {
            state: "REQUESTED",
            attemptId: "attempt_1",
            reason: "CANCELLATION",
            requestedAt: 1_000,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      resultModule.CommandResultSchema.safeParse({ kind: "CANCEL_RUN", run: cancelledRun }).success,
    ).toBe(false);
  });

  test("exposes session expiry and an optional mutation lease only for mutating mode", async () => {
    const module = await import("../../../src/shared/contracts/runs.ts");
    expect("AuthoritySessionViewSchema" in module).toBe(true);
    const schema = module.AuthoritySessionViewSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    const base = {
      id: "authority_session_1",
      attemptId: "attempt_1",
      fence: 1,
      issuedAt: 1_000,
      expiresAt: 31_000,
      repositoryAssurance: "ADVISORY",
      connectorEpochs: { connector_1: 1 },
    };
    expect(schema.safeParse({ ...base, repositoryMode: "INSPECT_ONLY" }).success).toBe(true);
    expect(
      schema.safeParse({
        ...base,
        repositoryMode: "INSPECT_ONLY",
        mutationLease: { leaseId: "lease_1", fence: 1, expiresAt: 16_000 },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        repositoryMode: "MUTATING",
        mutationLease: { leaseId: "lease_1", fence: 1, expiresAt: 16_000 },
      }).success,
    ).toBe(true);
  });

  test("enforces all direct dependency layer rules", async () => {
    const module = await import("./dependency-rules.ts");
    const violations = [
      ["src/shared/contracts/result.ts", "../../domain/run.ts"],
      ["src/domain/run.ts", "../server/modules/runs/store.ts"],
      ["src/server/modules/runs/store.ts", "../../adapters/http/routes/runs.ts"],
      ["src/server/adapters/http/routes/runs.ts", "../../mcp/tools.ts"],
      ["src/server/adapters/http/routes/runs.ts", "../../../../web/app.tsx"],
    ] as const;
    for (const [importer, specifier] of violations) {
      expect(module.validateImportEdge(importer, specifier).allowed).toBe(false);
    }
    expect(
      module.validateImportEdge(
        "src/server/adapters/http/routes/runs.ts",
        "../../../modules/execution-authority/contract.ts",
      ).allowed,
    ).toBe(true);
    expect(await module.scanSourceImports("src")).toEqual([]);
  });
});
