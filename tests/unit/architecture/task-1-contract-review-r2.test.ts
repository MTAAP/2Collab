import { describe, expect, test } from "bun:test";
import {
  CollabCommandSchema,
  CommandResultSchema,
} from "../../../src/shared/contracts/commands.ts";
import { ResultSchema } from "../../../src/shared/contracts/result.ts";
import { EvidenceInputSchema } from "../../../src/shared/contracts/runs.ts";
import { validateImportEdge } from "./dependency-rules.ts";

const actor = {
  kind: "MEMBER",
  memberId: "member_1",
  sessionId: "session_1",
  sessionProof: "proof_value_with_at_least_thirty_two_bytes",
} as const;
const commandBase = { actor, idempotencyKey: "idem_1" } as const;
const fullSha = "a".repeat(40);

function reconciliation(availability: string, observedRevision?: string) {
  return {
    ...commandBase,
    kind: "RECONCILE_OBSERVATION",
    runId: "run_1",
    expectedRunRevision: 2,
    observation: {
      kind: "SOURCE_REVISION",
      connectorId: "connector_1",
      sourceKind: "GITHUB_ISSUE",
      sourceItemId: "42",
      availability,
      ...(observedRevision === undefined ? {} : { observedRevision }),
      observedAt: 1_000,
    },
  };
}

function cancellation(termination?: Record<string, unknown>) {
  return {
    ...commandBase,
    kind: "CANCEL_RUN",
    runId: "run_1",
    expectedRunRevision: 2,
    reason: "MEMBER_REQUEST",
    ...(termination === undefined ? {} : { termination }),
  };
}

const waitingRun = {
  id: "run_1",
  coordinationRecordId: "record_1",
  state: "WAITING",
  goal: "Wait for input",
  repositoryMode: "INSPECT_ONLY",
  repositoryAssurance: "ADVISORY",
  revision: 2,
  attemptIds: ["attempt_1"],
} as const;

describe("Task 1 second review regressions", () => {
  test("allows imports within an adapter family and rejects cross-family edges", () => {
    expect(
      validateImportEdge("src/server/adapters/github/client.ts", "./contract.ts").allowed,
    ).toBe(true);
    expect(
      validateImportEdge("src/runner/adapters/runtime/claude.ts", "./contract.ts").allowed,
    ).toBe(true);
    expect(
      validateImportEdge("src/server/adapters/http/routes.ts", "../mcp/transport.ts").allowed,
    ).toBe(false);
    expect(
      validateImportEdge("src/runner/adapters/runtime/claude.ts", "../host/process.ts").allowed,
    ).toBe(false);
  });

  test("exports strict preview request, preview output, and query result schemas", async () => {
    const authority = (await import(
      "../../../src/shared/contracts/execution-authority.ts"
    )) as unknown as Record<string, { safeParse(value: unknown): { success: boolean } }>;
    const requestSchema = authority.AuthorityPreviewRequestSchema;
    const previewSchema = authority.AuthorityPreviewSchema;
    const queryResultSchema = authority.QueryResultSchema;

    expect(requestSchema).toBeDefined();
    expect(previewSchema).toBeDefined();
    expect(queryResultSchema).toBeDefined();
    if (!requestSchema || !previewSchema || !queryResultSchema) return;

    const request = {
      actor,
      projectId: "project_1",
      repository: {
        repositoryId: "repository_1",
        mode: "INSPECT_ONLY",
        assurance: "ADVISORY",
        base: { kind: "EXACT", commitSha: fullSha },
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
    };
    const preview = {
      evaluatedAt: 1_000,
      eligibleTargets: [
        {
          runnerId: "runner_1",
          profileVersionId: "profile_1",
          host: "NATIVE",
          interaction: "HEADLESS",
          assurance: "ADVISORY",
        },
      ],
      requirements: [
        {
          subject: "RUNNER",
          outcome: "ALLOWED",
          code: "RUNNER_ELIGIBLE",
          revision: "7",
          summary: "Runner is eligible.",
        },
      ],
      warnings: [],
    };
    const queryResult = { kind: "INSPECT_RUN", run: waitingRun };

    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(requestSchema.safeParse({ ...request, permit: "secret" }).success).toBe(false);
    expect(previewSchema.safeParse(preview).success).toBe(true);
    expect(previewSchema.safeParse({ ...preview, token: "secret" }).success).toBe(false);
    expect(queryResultSchema.safeParse(queryResult).success).toBe(true);
    expect(queryResultSchema.safeParse({ ...queryResult, transcript: "secret" }).success).toBe(
      false,
    );
  });

  test("requires complete bounded changed-path evidence", () => {
    const evidence = {
      kind: "CHANGED_PATHS",
      baseCommit: fullSha,
      observedAt: 1_000,
      paths: ["src/index.ts"],
      truncated: false,
    };
    expect(EvidenceInputSchema.safeParse(evidence).success).toBe(true);
    expect(EvidenceInputSchema.safeParse({ ...evidence, baseCommit: "abcdef0" }).success).toBe(
      false,
    );
    expect(EvidenceInputSchema.safeParse({ ...evidence, observedAt: undefined }).success).toBe(
      false,
    );
    expect(EvidenceInputSchema.safeParse({ ...evidence, truncated: undefined }).success).toBe(
      false,
    );
    expect(EvidenceInputSchema.safeParse({ ...evidence, paths: ["../outside"] }).success).toBe(
      false,
    );
    expect(
      EvidenceInputSchema.safeParse({ ...evidence, paths: Array(2_049).fill("src/index.ts") })
        .success,
    ).toBe(false);
  });

  test("requires revisions only for available source observations", () => {
    expect(CollabCommandSchema.safeParse(reconciliation("AVAILABLE", "etag-2")).success).toBe(true);
    expect(CollabCommandSchema.safeParse(reconciliation("AVAILABLE")).success).toBe(false);
    for (const availability of ["MISSING", "FORBIDDEN", "UNAVAILABLE"]) {
      expect(CollabCommandSchema.safeParse(reconciliation(availability)).success).toBe(true);
      expect(
        CollabCommandSchema.safeParse(reconciliation(availability, "must-not-exist")).success,
      ).toBe(false);
    }
    expect(
      CollabCommandSchema.safeParse(reconciliation("AVAILABLE", "x".repeat(129))).success,
    ).toBe(false);
  });

  test("bounds and validates audit identifiers", () => {
    expect(ResultSchema.safeParse({ ok: true, value: {}, auditId: "audit_123" }).success).toBe(
      true,
    );
    expect(ResultSchema.safeParse({ ok: true, value: {}, auditId: "" }).success).toBe(false);
    expect(ResultSchema.safeParse({ ok: true, value: {}, auditId: "x".repeat(129) }).success).toBe(
      false,
    );
    expect(ResultSchema.safeParse({ ok: true, value: {}, auditId: "audit/secret" }).success).toBe(
      false,
    );
  });

  test("derives cancellation termination instead of accepting caller authority", () => {
    expect(CollabCommandSchema.safeParse(cancellation()).success).toBe(true);
    expect(
      CollabCommandSchema.safeParse(
        cancellation({ kind: "REQUEST_TERMINATION", attemptId: "attempt_1" }),
      ).success,
    ).toBe(false);
    expect(
      CollabCommandSchema.safeParse(
        cancellation({ kind: "NO_ACTIVE_ATTEMPT", attemptId: "attempt_1" }),
      ).success,
    ).toBe(false);
    expect(
      CollabCommandSchema.safeParse(cancellation({ kind: "REQUEST_TERMINATION" })).success,
    ).toBe(false);

    expect(
      CommandResultSchema.safeParse({
        kind: "CANCEL_RUN",
        run: waitingRun,
        termination: { kind: "NO_ACTIVE_ATTEMPT" },
      }).success,
    ).toBe(true);
    expect(
      CommandResultSchema.safeParse({
        kind: "CANCEL_RUN",
        run: waitingRun,
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
  });
});
