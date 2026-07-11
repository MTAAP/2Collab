export const OUTLINE_REQUIREMENTS = [
  "OUT-001",
  "OUT-002",
  "OUT-003",
  "OUT-004",
  "OUT-005",
  "OUT-006",
  "OUT-007",
  "OUT-008",
  "OUT-009",
  "OUT-010",
] as const;
export type OutlineEvidenceStatus =
  | "NOT_RUN"
  | "LOCAL_PROOF_COMPLETE"
  | "IN_PROGRESS_LIVE"
  | "BLOCKED_ENV"
  | "PASS"
  | "FAIL";
export type OutlineEvidenceRow = Readonly<{
  requirement: (typeof OUTLINE_REQUIREMENTS)[number];
  build: string;
  gitRevision: string;
  providerRevision?: string;
  collabIds: readonly string[];
  journey: string;
  localPassed: boolean;
  livePassed: boolean;
  reviewer?: string;
  blocker?: string;
  liveEvidenceValidated?: boolean;
  localProofs?: readonly Readonly<{
    testPath: string;
    testName: string;
    status: "PASSED" | "FAILED" | "SKIPPED";
  }>[];
}>;
export const OUTLINE_LOCAL_OBLIGATIONS: Readonly<
  Record<(typeof OUTLINE_REQUIREMENTS)[number], Readonly<{ testPath: string; testName: string }>>
> = {
  "OUT-001": {
    testPath: "tests/integration/outline/oauth-transaction-store.test.ts",
    testName:
      "SQLite OAuth transactions consume once and recheck member, session, connector epoch, and encrypted verifier",
  },
  "OUT-002": {
    testPath: "tests/integration/outline/bot-attribution.test.ts",
    testName: "keeps delegated member and bot authority distinct",
  },
  "OUT-003": {
    testPath: "tests/integration/outline/read.test.ts",
    testName: "returns the current document body and stores only a safe projection",
  },
  "OUT-004": {
    testPath: "tests/integration/outline/revision-conflict.test.ts",
    testName: "stale member save preserves the authored patch digest and current reference",
  },
  "OUT-005": {
    testPath: "tests/integration/outline/agent-grants.test.ts",
    testName:
      "requests confer no authority until an explicit member approval extends the exact grant",
  },
  "OUT-006": {
    testPath: "tests/integration/outline/proposal-conflict.test.ts",
    testName: "never applies a proposal across an external revision",
  },
  "OUT-007": {
    testPath: "tests/integration/outline/working-document.test.ts",
    testName: "keep remains non-authoritative and promote/archive need member authority",
  },
  "OUT-008": {
    testPath: "tests/integration/outline/revocation.test.ts",
    testName: "denies a reserved write after RESTORE revocation",
  },
  "OUT-009": {
    testPath: "tests/drills/outline-data-canary.test.ts",
    testName:
      "scans the Foundation closed real-store inventory for encoded forbidden Outline bodies and tokens",
  },
  "OUT-010": {
    testPath: "tests/e2e/outline-dogfood.spec.ts",
    testName: "fixture-backed collaboration keeps exact grant and revocation boundaries",
  },
};

function hasExactLocalProof(row: OutlineEvidenceRow): boolean {
  if (!row.localPassed) return true;
  const obligation = OUTLINE_LOCAL_OBLIGATIONS[row.requirement];
  return (
    row.localProofs?.some(
      (proof) =>
        proof.testPath === obligation.testPath &&
        proof.testName === obligation.testName &&
        proof.status === "PASSED",
    ) === true
  );
}
export function deriveOutlineStatus(row: OutlineEvidenceRow): OutlineEvidenceStatus {
  if (row.blocker) return "BLOCKED_ENV";
  if (!row.localPassed) return "NOT_RUN";
  if (!row.livePassed) return "LOCAL_PROOF_COMPLETE";
  return row.reviewer && row.liveEvidenceValidated ? "PASS" : "IN_PROGRESS_LIVE";
}
export function validateOutlineEvidence(
  rows: readonly OutlineEvidenceRow[],
): Readonly<{ valid: boolean; statuses: Readonly<Record<string, OutlineEvidenceStatus>> }> {
  const statuses = Object.fromEntries(
    rows.map((row) => [row.requirement, deriveOutlineStatus(row)]),
  );
  return {
    valid:
      rows.length === OUTLINE_REQUIREMENTS.length &&
      new Set(rows.map((row) => row.requirement)).size === OUTLINE_REQUIREMENTS.length &&
      OUTLINE_REQUIREMENTS.every((requirement) => requirement in statuses) &&
      rows.every(
        (row) =>
          row.build.length > 0 &&
          row.gitRevision.length >= 7 &&
          hasExactLocalProof(row) &&
          (!row.livePassed ||
            (Boolean(row.providerRevision) &&
              row.collabIds.length > 0 &&
              Boolean(row.reviewer) &&
              row.liveEvidenceValidated === true)),
      ),
    statuses,
  };
}

export const LIVE_OUTLINE_TEST_NAME =
  "completes the approved disposable two-member Outline collaboration journey";

type PlaywrightResult = Readonly<{ status?: string }>;
type PlaywrightSpec = Readonly<{
  title?: string;
  tests?: readonly Readonly<{ results?: readonly PlaywrightResult[]; status?: string }>[];
}>;
type PlaywrightSuite = Readonly<{
  specs?: readonly PlaywrightSpec[];
  suites?: readonly PlaywrightSuite[];
}>;

export function validateLivePlaywrightReport(
  input: unknown,
): Readonly<{ valid: boolean; reason?: string }> {
  if (!input || typeof input !== "object")
    return { valid: false, reason: "PLAYWRIGHT_REPORT_INVALID" };
  const report = input as { suites?: readonly PlaywrightSuite[]; errors?: readonly unknown[] };
  const specs: PlaywrightSpec[] = [];
  const visit = (suite: PlaywrightSuite) => {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  const exact = specs.filter((spec) => spec.title === LIVE_OUTLINE_TEST_NAME);
  if (exact.length !== 1) return { valid: false, reason: "LIVE_TEST_OBLIGATION_MISSING" };
  const tests = exact[0]?.tests ?? [];
  const results = tests.flatMap((test) => test.results ?? []);
  if (tests.length === 0 || results.length === 0)
    return { valid: false, reason: "LIVE_TEST_NOT_RUN" };
  if (
    tests.some((test) => test.status !== "expected") ||
    results.some((result) => result.status !== "passed")
  )
    return { valid: false, reason: "LIVE_TEST_NOT_PASSED" };
  if ((report.errors?.length ?? 0) > 0) return { valid: false, reason: "PLAYWRIGHT_REPORT_FAILED" };
  return { valid: true };
}
