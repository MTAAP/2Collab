export const AUTOMATION_OBLIGATIONS = [
  ["AUT-001", "tests/unit/workflows/definition.test.ts", "has exactly the seven closed node kinds"],
  [
    "AUT-002",
    "tests/integration/workflows/execution.test.ts",
    "starts one durable child step only through ExecutionAuthority",
  ],
  [
    "AUT-003",
    "tests/integration/workflows/parallel-review.test.ts",
    "parallel groups prepare only bounded INSPECT_ONLY branches",
  ],
  [
    "AUT-004",
    "tests/unit/workflows/joins.test.ts",
    "ALL emits one keyed artifact map after every distinct branch",
  ],
  [
    "AUT-005",
    "tests/integration/workflows/conditional-fix.test.ts",
    "one typed major finding launches exactly one Fix Agent Run",
  ],
  [
    "AUT-006",
    "tests/integration/workflows/human-decision.test.ts",
    "a durable decision survives restart and schedules its choice once",
  ],
  [
    "AUT-007",
    "tests/integration/workflows/managed-loop.test.ts",
    "failed starts and lost attempts consume the same immutable maximum",
  ],
  [
    "AUT-008",
    "tests/integration/workflows/restart.test.ts",
    "a committed launch intent creates one child run after restart",
  ],
  [
    "AUT-009",
    "tests/integration/workflows/drafts.test.ts",
    "YAML round-trips only the executable schema",
  ],
  [
    "AUT-010",
    "tests/integration/workflows/planning.test.ts",
    "a portable Plan Artifact crosses runtime and runner choices",
  ],
  [
    "AUT-011",
    "tests/unit/gates/fingerprint.test.ts",
    "fingerprints the closed manifest deterministically without exposing local recipes",
  ],
  [
    "AUT-012",
    "tests/runner/gates/local-evaluator.test.ts",
    "resolves the approved recipe locally, authorizes it, and never invokes a shell",
  ],
  [
    "AUT-013",
    "tests/integration/gates/evaluations.test.ts",
    "persists bounded local evidence and fails tracked mutation",
  ],
  [
    "AUT-014",
    "tests/e2e/bounded-automation.spec.ts",
    "live canonical real PR remains blocked without approved resources",
  ],
] as const;

export type AutomationRequirement = (typeof AUTOMATION_OBLIGATIONS)[number][0];
