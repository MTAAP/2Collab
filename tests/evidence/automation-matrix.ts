import { readFile } from "node:fs/promises";

export type AutomationTestLevel =
  | "UNIT"
  | "INTEGRATION"
  | "PROPERTY"
  | "BROWSER_E2E"
  | "E2E"
  | "CONCURRENCY_INTEGRATION"
  | "FAULT_INTEGRATION"
  | "RUNNER_CONFORMANCE"
  | "SECURITY"
  | "TIME_CONTROLLED_FAULT_INTEGRATION"
  | "LIVE_DOGFOOD";

export type AutomationObligation = Readonly<{
  id: string;
  level: AutomationTestLevel;
  runner: "BUN" | "PLAYWRIGHT";
  testPath: string;
  testName: string;
}>;

export type AutomationRequirement = Readonly<{
  id: `AUT-${string}`;
  anchor: string;
  requirement: string;
  observable: string;
  testLevel: string;
  obligations: readonly AutomationObligation[];
}>;

const obligation = (
  id: string,
  level: AutomationTestLevel,
  testPath: string,
  testName: string,
  runner: "BUN" | "PLAYWRIGHT" = "BUN",
): AutomationObligation => ({ id, level, runner, testPath, testName });

export const AUTOMATION_REQUIREMENTS: readonly AutomationRequirement[] = [
  {
    id: "AUT-001",
    anchor: "team-run-templates-v1",
    requirement:
      "Team Run Templates are portable, versioned, and contain no local commands or credentials.",
    observable:
      "Bind one template to two Personal Run Presets; template edits affect only future runs.",
    testLevel: "Unit + integration",
    obligations: [
      obligation(
        "AUT001_PORTABLE_TEMPLATE",
        "UNIT",
        "tests/unit/templates/portable-template.test.ts",
        "accepts a bounded portable definition",
      ),
      obligation(
        "AUT001_IMMUTABLE_TEMPLATE_VERSIONS",
        "INTEGRATION",
        "tests/integration/templates/run-templates.test.ts",
        "publishes immutable versions and preserves prior bytes",
      ),
      obligation(
        "AUT001_PERSONAL_BINDINGS_SNAPSHOTTED",
        "INTEGRATION",
        "tests/integration/workflows/execution.test.ts",
        "loads immutable template and exact preset bindings and snapshots typed inputs server-side",
      ),
    ],
  },
  {
    id: "AUT-002",
    anchor: "visual-workflow-authoring-v1",
    requirement: "Workflow Definition is canonical and Canvas Layout cannot change execution.",
    observable:
      "Layout-only edits preserve semantic version; transition/contract edits create a new version.",
    testLevel: "Unit + browser E2E",
    obligations: [
      obligation(
        "AUT002_LAYOUT_NON_SEMANTIC",
        "UNIT",
        "tests/unit/workflows/layout.test.ts",
        "layout changes do not change workflow semantics",
      ),
      obligation(
        "AUT002_DEFINITION_SEMANTIC_HASH",
        "UNIT",
        "tests/unit/workflows/definition.test.ts",
        "semantic changes change the semantic hash",
      ),
      obligation(
        "AUT002_STUDIO_AUTHORING",
        "BROWSER_E2E",
        "tests/e2e/workflow-authoring.spec.ts",
        "workflow authoring exposes a keyboard-operable synchronized outline",
        "PLAYWRIGHT",
      ),
    ],
  },
  {
    id: "AUT-003",
    anchor: "automated-run-workflows-v1",
    requirement:
      "Validation rejects missing terminal/fix paths, unsafe joins, unbounded cycles, and parallel mutating steps.",
    observable: "Negative fixture suite returns stable diagnostics before publication.",
    testLevel: "Property + unit",
    obligations: [
      obligation(
        "AUT003_NEGATIVE_GRAPH_FIXTURES",
        "PROPERTY",
        "tests/unit/workflows/validation.test.ts",
        "rejects invalid graphs with %s",
      ),
      obligation(
        "AUT003_PARALLEL_MUTATION_REJECTED",
        "UNIT",
        "tests/unit/workflows/validation.test.ts",
        "rejects mutating work in a parallel group",
      ),
      obligation(
        "AUT003_TERMINAL_PATH_REQUIRED",
        "UNIT",
        "tests/unit/workflows/validation.test.ts",
        "rejects reachable paths that cannot reach a terminal",
      ),
      obligation(
        "AUT003_TYPED_JOIN_VALIDATION",
        "UNIT",
        "tests/unit/workflows/validation.test.ts",
        "validates parallel joins and exact policy transitions",
      ),
    ],
  },
  {
    id: "AUT-004",
    anchor: "team-workflow-templates-and-personal-workflow-presets-v1",
    requirement: "Every agent step has an explicit compatible personal binding.",
    observable:
      "Distinct runtimes/models/runners/hosts/modes execute; stale/missing binding pauses without substitution.",
    testLevel: "Integration + E2E",
    obligations: [
      obligation(
        "AUT004_STALE_BINDING_PAUSES",
        "INTEGRATION",
        "tests/integration/workflows/bindings.test.ts",
        "missing or stale bindings require an explicit replacement",
      ),
      obligation(
        "AUT004_DISTINCT_BINDINGS_SNAPSHOTTED",
        "INTEGRATION",
        "tests/integration/workflows/bindings.test.ts",
        "snapshots distinct exact runtime bindings without substitution",
      ),
      obligation(
        "AUT004_BOUND_JOURNEY",
        "E2E",
        "tests/e2e/bounded-automation.spec.ts",
        "authors and executes Implementation -> reviews -> conditional Fix -> Terminal",
        "PLAYWRIGHT",
      ),
    ],
  },
  {
    id: "AUT-005",
    anchor: "workflow-execution-lifecycle-v1",
    requirement: "Workflow events create distinct linked Agent Runs exactly once.",
    observable:
      "Restart coordinator and replay duplicate transitions; exactly one run exists per step under one record.",
    testLevel: "Concurrency/fault integration",
    obligations: [
      obligation(
        "AUT005_DUPLICATE_START_EXACTLY_ONCE",
        "CONCURRENCY_INTEGRATION",
        "tests/integration/workflows/idempotency.test.ts",
        "duplicate starts and terminal events cannot launch twice",
      ),
      obligation(
        "AUT005_RESTART_LAUNCH_INTENT",
        "FAULT_INTEGRATION",
        "tests/integration/workflows/restart.test.ts",
        "a committed launch intent creates one child run after restart",
      ),
      obligation(
        "AUT005_DUPLICATE_EVENT_DRILL",
        "FAULT_INTEGRATION",
        "tests/drills/workflow-duplicate-events.test.ts",
        "duplicate workflow events retain a stable semantic digest",
      ),
    ],
  },
  {
    id: "AUT-006",
    anchor: "automated-run-workflows-v1",
    requirement:
      "Parallel groups contain only `INSPECT_ONLY` runs and joins consume typed results.",
    observable:
      "Claude and Codex reviews run concurrently; `ALL`/`ANY` matches policy and no transition parses prose.",
    testLevel: "Integration",
    obligations: [
      obligation(
        "AUT006_PARALLEL_INSPECT_ONLY",
        "INTEGRATION",
        "tests/integration/workflows/parallel-review.test.ts",
        "parallel groups prepare only bounded INSPECT_ONLY branches",
      ),
      obligation(
        "AUT006_ALL_TYPED_JOIN",
        "INTEGRATION",
        "tests/unit/workflows/joins.test.ts",
        "ALL emits one keyed artifact map after every distinct branch",
      ),
      obligation(
        "AUT006_ANY_TYPED_JOIN",
        "INTEGRATION",
        "tests/unit/workflows/joins.test.ts",
        "ANY accepts one matching result and applies CANCEL_REMAINDER once",
      ),
    ],
  },
  {
    id: "AUT-007",
    anchor: "workflow-execution-lifecycle-v1",
    requirement: "Human gates are durable and never park an agent process.",
    observable:
      "Reach decision, prove all processes exited, restart, decide, and observe the correct next run.",
    testLevel: "Fault integration + E2E",
    obligations: [
      obligation(
        "AUT007_DECISION_SURVIVES_RESTART",
        "FAULT_INTEGRATION",
        "tests/integration/workflows/human-decision.test.ts",
        "a durable decision survives restart and schedules its choice once",
      ),
      obligation(
        "AUT007_NO_PARKED_PROCESS",
        "FAULT_INTEGRATION",
        "tests/drills/workflow-no-parked-process.test.ts",
        "WAITING human decisions require no active process",
      ),
      obligation(
        "AUT007_DECISION_JOURNEY",
        "E2E",
        "tests/e2e/bounded-automation.spec.ts",
        "authors and executes Implementation -> reviews -> conditional Fix -> Terminal",
        "PLAYWRIGHT",
      ),
    ],
  },
  {
    id: "AUT-008",
    anchor: "diff-evidence-and-review-policy-v1",
    requirement: "Conditional Fix runs launch only from typed review results.",
    observable:
      "Major finding triggers Fix; clean/minor-only reaches terminal; missing result follows declared fallback.",
    testLevel: "Integration",
    obligations: [
      obligation(
        "AUT008_TYPED_RESULT_ROUTING",
        "INTEGRATION",
        "tests/integration/workflows/conditional-fix.test.ts",
        "only the typed major-finding result selects Fix",
      ),
      obligation(
        "AUT008_SINGLE_FIX_RUN",
        "INTEGRATION",
        "tests/integration/workflows/conditional-fix.test.ts",
        "one typed major finding launches exactly one Fix Agent Run",
      ),
      obligation(
        "AUT008_MISSING_RESULT_FALLBACK",
        "INTEGRATION",
        "tests/unit/workflows/conditions.test.ts",
        "routes RESULT_CONTRACT_VIOLATION to human-review without prose inspection",
      ),
    ],
  },
  {
    id: "AUT-009",
    anchor: "repository-defined-quality-gates-v1",
    requirement:
      "Gates use trusted-base manifests, owner-approved fingerprints, named sets, and exact revisions.",
    observable:
      "Self-modified manifest, stale fingerprint, transmitted command, wrong revision, and tracked-file mutation fail.",
    testLevel: "Runner conformance + security",
    obligations: [
      obligation(
        "AUT009_TRUSTED_FINGERPRINT",
        "RUNNER_CONFORMANCE",
        "tests/unit/gates/fingerprint.test.ts",
        "fingerprints the closed manifest deterministically without exposing local recipes",
      ),
      obligation(
        "AUT009_STALE_FINGERPRINT_REJECTED",
        "RUNNER_CONFORMANCE",
        "tests/runner/gates/local-evaluator.test.ts",
        "rejects stale fingerprints before authority or process start",
      ),
      obligation(
        "AUT009_TRANSMITTED_COMMAND_REJECTED",
        "SECURITY",
        "tests/runner/gates/local-evaluator.test.ts",
        "rejects a server-transmitted command before authority or process start",
      ),
      obligation(
        "AUT009_WRONG_SHA_REJECTED",
        "SECURITY",
        "tests/integration/gates/evaluations.test.ts",
        "wrong SHA and replay under another binding fail closed",
      ),
      obligation(
        "AUT009_TRACKED_MUTATION_REJECTED",
        "SECURITY",
        "tests/integration/gates/evaluations.test.ts",
        "persists bounded local evidence and fails tracked mutation",
      ),
    ],
  },
  {
    id: "AUT-010",
    anchor: "managed-loop-stop-policies-v1",
    requirement:
      "Managed Loops require semantic stop, positive attempt bound, and absolute deadline.",
    observable:
      "Exercise achieved, attempt exhaustion, deadline, failed start, and lost attempt; every created attempt counts.",
    testLevel: "Property + fault integration",
    obligations: [
      obligation(
        "AUT010_THREE_VALUED_STOP_POLICY",
        "PROPERTY",
        "tests/unit/workflows/stop-policy.test.ts",
        "ALL ANY and NOT preserve UNKNOWN",
      ),
      obligation(
        "AUT010_ATTEMPT_BOUND",
        "FAULT_INTEGRATION",
        "tests/integration/workflows/managed-loop.test.ts",
        "failed starts and lost attempts consume the same immutable maximum",
      ),
      obligation(
        "AUT010_LOOP_DEADLINE",
        "FAULT_INTEGRATION",
        "tests/integration/workflows/managed-loop.test.ts",
        "the loop deadline cannot be disabled or extended",
      ),
    ],
  },
  {
    id: "AUT-011",
    anchor: "workflow-execution-lifecycle-v1",
    requirement: "Pause, waiting, restart, and revocation never reset or extend deadlines.",
    observable:
      "Pause past deadline, restart, revoke authority, replay events; no extra attempt launches.",
    testLevel: "Time-controlled fault integration",
    obligations: [
      obligation(
        "AUT011_PAUSE_RESTART_DEADLINE",
        "TIME_CONTROLLED_FAULT_INTEGRATION",
        "tests/drills/workflow-deadline.test.ts",
        "pause and restart never extend the absolute deadline",
      ),
      obligation(
        "AUT011_REVOKED_FUTURE_WORK",
        "TIME_CONTROLLED_FAULT_INTEGRATION",
        "tests/integration/workflows/revocation.test.ts",
        "revocation invalidates affected future work and retains unaffected active work",
      ),
      obligation(
        "AUT011_RESULT_WHILE_PAUSED",
        "TIME_CONTROLLED_FAULT_INTEGRATION",
        "tests/drills/workflow-deadline.test.ts",
        "results arriving while paused do not launch the next step until resume",
      ),
    ],
  },
  {
    id: "AUT-012",
    anchor: "portable-planning-workflows-v1",
    requirement:
      "Planning produces typed Plan Artifacts and optional durable approval without universal plan-mode flags.",
    observable:
      "Plan with one runtime, approve/reject, implement with another; schema contains no runtime-specific plan flag.",
    testLevel: "Integration + E2E",
    obligations: [
      obligation(
        "AUT012_PORTABLE_PLAN_ARTIFACT",
        "INTEGRATION",
        "tests/integration/workflows/planning.test.ts",
        "a portable Plan Artifact crosses runtime and runner choices",
      ),
      obligation(
        "AUT012_NO_RUNTIME_PLAN_FLAG",
        "INTEGRATION",
        "tests/unit/workflows/plan-artifact.test.ts",
        "Plan Artifacts contain no runtime plan mode or hidden process state",
      ),
      obligation(
        "AUT012_CROSS_RUNTIME_PLAN_JOURNEY",
        "E2E",
        "tests/e2e/planning-workflow.spec.ts",
        "one runtime plans and a distinct runtime consumes the portable artifact",
        "PLAYWRIGHT",
      ),
    ],
  },
  {
    id: "AUT-013",
    anchor: "best-effort-usage-telemetry-v1",
    requirement: "Workflow aggregation preserves partial coverage and separates gate time.",
    observable:
      "Mixed known/unknown child metrics produce labelled partial totals with gate duration separate.",
    testLevel: "Unit + integration",
    obligations: [
      obligation(
        "AUT013_PARTIAL_USAGE_TOTALS",
        "UNIT",
        "tests/unit/workflows/usage.test.ts",
        "labels partial totals and separates gate time",
      ),
      obligation(
        "AUT013_USAGE_PROJECTION",
        "INTEGRATION",
        "tests/integration/workflows/usage.test.ts",
        "workflow aggregation remains a projection over immutable attempts and gates",
      ),
    ],
  },
  {
    id: "AUT-014",
    anchor: "dogfood-delivery-slices-and-exit-criteria",
    requirement:
      "The canonical implementation-review-fix workflow is authored and executed end to end.",
    observable:
      "Create materially in React Flow and execute `Implementation -> parallel Claude and Codex review -> conditional Fix -> Terminal` on a real PR; duplicate/restart/deadline/no-park proofs pass.",
    testLevel: "Live dogfood",
    obligations: [
      obligation(
        "AUT014_CANONICAL_REAL_PR_JOURNEY",
        "LIVE_DOGFOOD",
        "tests/e2e/bounded-automation-live.spec.ts",
        "executes the approved canonical workflow on a real pull request",
        "PLAYWRIGHT",
      ),
    ],
  },
] as const;

const EXPECTED_LEVELS: Readonly<Record<string, readonly AutomationTestLevel[]>> = {
  "Unit + integration": ["UNIT", "INTEGRATION"],
  "Unit + browser E2E": ["UNIT", "BROWSER_E2E"],
  "Property + unit": ["PROPERTY", "UNIT"],
  "Integration + E2E": ["INTEGRATION", "E2E"],
  "Concurrency/fault integration": ["CONCURRENCY_INTEGRATION", "FAULT_INTEGRATION"],
  Integration: ["INTEGRATION"],
  "Fault integration + E2E": ["FAULT_INTEGRATION", "E2E"],
  "Runner conformance + security": ["RUNNER_CONFORMANCE", "SECURITY"],
  "Property + fault integration": ["PROPERTY", "FAULT_INTEGRATION"],
  "Time-controlled fault integration": ["TIME_CONTROLLED_FAULT_INTEGRATION"],
  "Live dogfood": ["LIVE_DOGFOOD"],
};

function parseAutomationMatrix(
  markdown: string,
): Map<string, Omit<AutomationRequirement, "obligations">> {
  const rows = new Map<string, Omit<AutomationRequirement, "obligations">>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| `AUT-")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const id = cells[0]?.replaceAll("`", "") as `AUT-${string}`;
    const anchor = cells[1]?.match(/#[^)]+/)?.[0].slice(1);
    if (!id || !anchor) continue;
    rows.set(id, {
      id,
      anchor,
      requirement: cells[2] ?? "",
      observable: cells[3] ?? "",
      testLevel: cells[4] ?? "",
    });
  }
  return rows;
}

export async function validateAutomationRegistryAgainstMatrix(
  registry: readonly AutomationRequirement[] = AUTOMATION_REQUIREMENTS,
  matrixPath = "docs/acceptance/ACCEPTANCE-MATRIX.md",
): Promise<Readonly<{ valid: boolean; reason?: string }>> {
  const canonical = parseAutomationMatrix(await readFile(matrixPath, "utf8"));
  if (registry.length !== 14 || canonical.size !== 14)
    return { valid: false, reason: "AUTOMATION_CANONICAL_REQUIREMENT_SET_INVALID" };
  if (new Set(registry.map(({ id }) => id)).size !== registry.length)
    return { valid: false, reason: "AUTOMATION_REQUIREMENT_DUPLICATE" };
  const obligationIds = registry.flatMap(({ obligations }) => obligations.map(({ id }) => id));
  if (new Set(obligationIds).size !== obligationIds.length)
    return { valid: false, reason: "AUTOMATION_OBLIGATION_DUPLICATE" };
  for (const entry of registry) {
    const expected = canonical.get(entry.id);
    if (
      !expected ||
      entry.anchor !== expected.anchor ||
      entry.requirement !== expected.requirement ||
      entry.observable !== expected.observable ||
      entry.testLevel !== expected.testLevel
    )
      return { valid: false, reason: `AUTOMATION_CANONICAL_MAPPING_INVALID:${entry.id}` };
    const expectedLevels = EXPECTED_LEVELS[entry.testLevel];
    const actualLevels = new Set(entry.obligations.map(({ level }) => level));
    if (!expectedLevels || expectedLevels.some((level) => !actualLevels.has(level)))
      return { valid: false, reason: `AUTOMATION_TEST_LEVEL_MISSING:${entry.id}` };
    if (
      entry.obligations.length === 0 ||
      entry.obligations.some(
        ({ id, testPath, testName }) =>
          !id.startsWith(entry.id.replace("-", "")) || !testPath || !testName,
      )
    )
      return { valid: false, reason: `AUTOMATION_OBLIGATION_INVALID:${entry.id}` };
  }
  return { valid: true };
}

// Compatibility alias for callers that only need the obligation inventory.
export const AUTOMATION_OBLIGATIONS = AUTOMATION_REQUIREMENTS.flatMap(({ id, obligations }) =>
  obligations.map((entry) => ({ requirement: id, ...entry })),
);
