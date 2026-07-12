export type FoundationProofObligation = Readonly<{
  id: string;
  evidenceKind: string;
  testPath: string;
  testName: string;
}>;
export type FoundationRequirementProof = Readonly<{
  requirementId: string;
  proofObligations: readonly FoundationProofObligation[];
  externalProof: readonly string[];
  statusRule: "ALL_LOCAL" | "LOCAL_AND_EXTERNAL" | "EXTERNAL_ONLY";
}>;

export const localFoundationMatrix: readonly FoundationRequirementProof[] = Object.freeze([
  {
    requirementId: "FND-001",
    proofObligations: [
      {
        id: "EMPTY_BOOTSTRAP_ONE_OWNER",
        evidenceKind: "BROWSER_E2E",
        testPath: "tests/e2e/setup-and-members.spec.ts",
        testName: "empty deployment bootstrap registers the owner with Better Auth and signs in",
      },
      {
        id: "RESTORE_PRESERVES_SINGLETON",
        evidenceKind: "RESTORE_DRILL",
        testPath: "tests/drills/backup-restore.test.ts",
        testName: "restores only through isolated staging and invalidates restored authority",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-002",
    proofObligations: [
      {
        id: "IDENTITY_LIFECYCLE",
        evidenceKind: "INTEGRATION",
        testPath: "tests/integration/identity/better-auth-bootstrap.test.ts",
        testName:
          "does not claim a deployment until the registered passkey exists and completes once",
      },
      {
        id: "IDENTITY_REPLAY",
        evidenceKind: "SECURITY_DRILL",
        testPath: "tests/drills/identity-replay.test.ts",
        testName: "same identity command replays safely while changed input conflicts",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-003",
    proofObligations: [
      {
        id: "PROJECT_PARITY",
        evidenceKind: "INTEGRATION",
        testPath: "tests/integration/cli-projects.test.ts",
        testName:
          "lists known projects outside repositories and reports unreachable origins honestly",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-004",
    proofObligations: [
      {
        id: "PAIRING_BINDING",
        evidenceKind: "INTEGRATION",
        testPath: "tests/integration/runners/pairing.test.ts",
        testName:
          "binds device, confirming member, and new runner key while persisting hashes only",
      },
      {
        id: "OWNER_POLICY",
        evidenceKind: "INTEGRATION",
        testPath: "tests/integration/runners/ownership-policy.test.ts",
        testName:
          "keeps policy replacement private to committed authority facts and uses CAS revisions",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-005",
    proofObligations: [
      {
        id: "RUNTIME_CONFORMANCE",
        evidenceKind: "RUNNER_CONFORMANCE",
        testPath: "tests/runner/conformance/runtime.test.ts",
        testName: "Claude and Codex prepare argv without starting a process",
      },
      {
        id: "HOST_CONFORMANCE",
        evidenceKind: "RUNNER_CONFORMANCE",
        testPath: "tests/runner/conformance/host.test.ts",
        testName: "Native and Orca start prepared headless and interactive execution locally",
      },
    ],
    externalProof: ["TWO_MACHINE_RUNTIME_HOST_MODE_MATRIX"],
    statusRule: "LOCAL_AND_EXTERNAL",
  },
  {
    requirementId: "FND-006",
    proofObligations: [
      {
        id: "IMMUTABLE_PRESET",
        evidenceKind: "INTEGRATION",
        testPath: "tests/integration/configuration/snapshots.test.ts",
        testName:
          "preset edits cannot rewrite the effective configuration and envelope captured for a run",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-007",
    proofObligations: [
      {
        id: "PERMIT_REPLAY_FENCE",
        evidenceKind: "SECURITY_INTEGRATION",
        testPath: "tests/integration/execution-authority/lifecycle.test.ts",
        testName: "permit replay and stale session fences fail before an operation",
      },
      {
        id: "ADVISORY_ENFORCEMENT",
        evidenceKind: "RUNNER_CONFORMANCE",
        testPath: "tests/runner/conformance/enforcement.test.ts",
        testName: "reports advisory truth and never accepts an enforced request",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-008",
    proofObligations: [
      {
        id: "LOST_WAITING_RESUME",
        evidenceKind: "FAULT_INJECTION",
        testPath: "tests/integration/execution-authority/lifecycle.test.ts",
        testName: "lost attempt waits and resume creates a new immutable attempt",
      },
      {
        id: "RUNNER_LOSS",
        evidenceKind: "FAULT_DRILL",
        testPath: "tests/drills/runner-loss.test.ts",
        testName: "runner becomes offline at 30 seconds and an active attempt becomes LOST at 90",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-009",
    proofObligations: [
      {
        id: "OFFLINE_GRACE",
        evidenceKind: "NETWORK_DRILL",
        testPath: "tests/drills/network-partition.test.ts",
        testName: "mutation stops after grace while inspect-only continues only to its deadline",
      },
      {
        id: "OUTBOX_CAUSAL",
        evidenceKind: "NETWORK_DRILL",
        testPath: "tests/drills/network-partition.test.ts",
        testName: "semantic outbox preserves causal identity and terminal reserve across restart",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-010",
    proofObligations: [
      {
        id: "WORKTREE_REUSE",
        evidenceKind: "RUNNER_INTEGRATION",
        testPath: "tests/runner/worktrees.test.ts",
        testName: "one run reuses one worktree and dirty work is retained",
      },
      {
        id: "WORKTREE_SERIALIZATION",
        evidenceKind: "RUNNER_INTEGRATION",
        testPath: "tests/runner/worktrees.test.ts",
        testName:
          "concurrent calls serialize per repository while separate repositories progress independently",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-011",
    proofObligations: [
      {
        id: "CLEANUP_RETENTION",
        evidenceKind: "DESTRUCTIVE_ACTION_DRILL",
        testPath: "tests/runner/worktrees.test.ts",
        testName:
          "cleanup retains tracked, untracked, unpublished, remote-unavailable, and unavailable-authority work",
      },
      {
        id: "OWNER_DISCARD",
        evidenceKind: "DESTRUCTIVE_ACTION_DRILL",
        testPath: "tests/runner/worktrees.test.ts",
        testName:
          "only a separately authorized runner owner can discard the exact retained observation",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-012",
    proofObligations: [
      {
        id: "RUNNER_PROTOCOL_SECURITY",
        evidenceKind: "PROTOCOL_SECURITY",
        testPath: "tests/drills/runner-security.test.ts",
        testName:
          "arbitrary commands, binary frames, and oversized frames never reach semantic routing",
      },
      {
        id: "STORAGE_CANARY",
        evidenceKind: "STORAGE_SCAN",
        testPath: "tests/drills/storage-canary.test.ts",
        testName: "raw canaries never enter the closed durable-store inventory",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-013",
    proofObligations: [
      {
        id: "AUTHENTICATED_RESTORE",
        evidenceKind: "OPERATIONAL_RESTORE_DRILL",
        testPath: "tests/drills/backup-restore.test.ts",
        testName: "restores only through isolated staging and invalidates restored authority",
      },
      {
        id: "RESTORE_PLANNER",
        evidenceKind: "OPERATOR_SAFETY",
        testPath: "tests/drills/copied-backup-procedure.test.ts",
        testName:
          "refuses production or existing volumes and defaults to dry-run without listeners",
      },
    ],
    externalProof: ["COPIED_ISOLATED_RESTORE"],
    statusRule: "LOCAL_AND_EXTERNAL",
  },
  {
    requirementId: "FND-014",
    proofObligations: [
      {
        id: "SURFACE_PARITY",
        evidenceKind: "CONTRACT",
        testPath: "tests/protocol/cli-stdio-parity.test.ts",
        testName: "the compiled main executable exercises the real HTTP surface for both aliases",
      },
      {
        id: "MCP_PARITY",
        evidenceKind: "CONTRACT",
        testPath: "tests/protocol/surface-parity.test.ts",
        testName:
          "installed SDK Streamable HTTP calls the same canonical run tool over actual Hono",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-015",
    proofObligations: [
      {
        id: "EXACT_EXPOSURE",
        evidenceKind: "AUTHORIZATION_SECURITY",
        testPath: "tests/integration/runners/exposures.test.ts",
        testName: "requires the exact server-authored acknowledgement and hides private facts",
      },
      {
        id: "EXPOSURE_PRIVACY",
        evidenceKind: "AUTHORIZATION_SECURITY",
        testPath: "tests/integration/runners/privacy.test.ts",
        testName:
          "makes private, missing, revoked, and non-team exposures indistinguishable to non-owners",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-016",
    proofObligations: [
      {
        id: "CONTEXT_BOUNDS",
        evidenceKind: "UNIT",
        testPath: "tests/unit/configuration/context.test.ts",
        testName:
          "deduplicates deterministically, applies category and total bounds, and reports omissions",
      },
      {
        id: "CONTEXT_STORAGE",
        evidenceKind: "INTEGRATION",
        testPath: "tests/integration/configuration/snapshots.test.ts",
        testName: "persists recipe budgets and bounded envelopes without granting authority",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-017",
    proofObligations: [
      {
        id: "UNKNOWN_COVERAGE",
        evidenceKind: "UNIT",
        testPath: "tests/unit/configuration/telemetry.test.ts",
        testName: "keeps unknown eligible attempts in coverage instead of inventing zero",
      },
      {
        id: "TELEMETRY_SNAPSHOT",
        evidenceKind: "INTEGRATION",
        testPath: "tests/integration/configuration/snapshots.test.ts",
        testName:
          "keeps eligible unknown attempts in coverage and rejects observation-id conflicts",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-018",
    proofObligations: [
      {
        id: "DIAGNOSTIC_ENCRYPTION",
        evidenceKind: "RUNNER_SECURITY",
        testPath: "tests/runner/local-diagnostics.test.ts",
        testName: "stores only encrypted bounded tails and exposes allowlisted metadata",
      },
      {
        id: "DIAGNOSTIC_LIMITS",
        evidenceKind: "RUNNER_SECURITY",
        testPath: "tests/runner/local-diagnostics.test.ts",
        testName: "defaults interactive collection off and enforces byte and age caps",
      },
    ],
    externalProof: [],
    statusRule: "ALL_LOCAL",
  },
  {
    requirementId: "FND-019",
    proofObligations: [
      {
        id: "STREAK_DERIVATION",
        evidenceKind: "EVIDENCE_CONTRACT",
        testPath: "tests/unit/evidence/consecutive-days.test.ts",
        testName: "uses calendar dates across DST and resets on repairs or missing dates",
      },
    ],
    externalProof: ["SEVEN_CONSECUTIVE_REVIEWED_DAYS"],
    statusRule: "EXTERNAL_ONLY",
  },
]);
