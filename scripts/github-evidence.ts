import { readFile } from "node:fs/promises";

type ReportResult = Readonly<{ status?: string }>;
type ReportTest = Readonly<{ results?: readonly ReportResult[] }>;
type ReportSpec = Readonly<{ title: string; tests?: readonly ReportTest[] }>;
type ReportSuite = Readonly<{
  specs?: readonly ReportSpec[];
  suites?: readonly ReportSuite[];
}>;
type Report = Readonly<{
  errors?: readonly unknown[];
  stats?: Readonly<{ unexpected?: number; skipped?: number }>;
  suites?: readonly ReportSuite[];
}>;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
async function main() {
  const [command, reportPath] = process.argv.slice(2);
  if (command !== "validate-live" || !reportPath)
    fail("Usage: github-evidence validate-live <playwright-json>");
  if (process.env.COLLAB_LIVE_GITHUB !== "1") fail("LIVE_GITHUB_NOT_AUTHORIZED");
  for (const name of [
    "COLLAB_GITHUB_INSTALLATION_ID",
    "COLLAB_GITHUB_REPOSITORY_ID",
    "COLLAB_GITHUB_PROJECT_ID",
    "COLLAB_GITHUB_APPROVAL_ID",
  ])
    if (!process.env[name] || !/^[A-Za-z0-9_-]{1,128}$/.test(process.env[name] ?? ""))
      fail(`LIVE_GITHUB_TARGET_INVALID:${name}`);
  if (!String(process.env.COLLAB_GITHUB_APPROVAL_ID).startsWith("approval_"))
    fail("LIVE_GITHUB_APPROVAL_INVALID");
  const report = JSON.parse(await readFile(reportPath, "utf8")) as Report;
  const evidencePath = process.env.COLLAB_GITHUB_EVIDENCE_RECORD;
  if (!evidencePath) fail("LIVE_GITHUB_EVIDENCE_RECORD_REQUIRED");
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  if (
    evidence.schemaVersion !== 1 ||
    evidence.approvalId !== process.env.COLLAB_GITHUB_APPROVAL_ID ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(evidence.reviewer?.memberId ?? "") ||
    Number.isNaN(Date.parse(evidence.reviewer?.reviewedAt ?? "")) ||
    ![evidence.providerResourceIds, evidence.collabResourceIds, evidence.auditEventIds].every(
      (values) => Array.isArray(values) && values.length > 0,
    )
  )
    fail("LIVE_GITHUB_EVIDENCE_RECORD_INVALID");
  const mutations = [
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
  const requiredEvidence = new Map<string, string>([
    ["github-live-planning-projections", "PLANNING_PROJECTIONS"],
    ...mutations.map(
      (mutation) => [`github-live-mutation-${mutation}`, `MUTATION_${mutation}`] as const,
    ),
    ["github-live-assignment-delegation", "ASSIGNMENT_DELEGATION"],
    ["github-live-stale-cas-rejected", "STALE_CAS_REJECTED"],
    ["github-live-delivery-closing-reference", "DELIVERY_CLOSING_REFERENCE"],
    ["github-live-delivery-merged-and-closed", "DELIVERY_MERGED_AND_CLOSED"],
    ["github-live-reviewer-approved", "REVIEWER_APPROVED"],
    ["github-live-check-exact-sha", "CHECK_EXACT_SHA"],
    ["github-live-check-failed-conclusion-blocked", "CHECK_FAILURE_BLOCKED"],
    ["github-live-diff-and-collision-evidence", "DIFF_AND_COLLISION_EVIDENCE"],
  ]);
  const specs: ReportSpec[] = [];
  const visit = (suite: ReportSuite) => {
    if (Array.isArray(suite?.specs)) specs.push(...suite.specs);
    if (Array.isArray(suite?.suites)) for (const child of suite.suites) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  const statuses = new Map<string, string[]>();
  for (const spec of specs)
    statuses.set(
      spec.title,
      (spec.tests ?? []).flatMap((entry) =>
        (entry.results ?? []).flatMap((result) => result.status ?? []),
      ),
    );
  if (report.errors?.length || report.stats?.unexpected || report.stats?.skipped)
    fail("LIVE_GITHUB_TEST_FAILED");
  for (const [title, obligation] of requiredEvidence)
    if (!statuses.get(title)?.length || statuses.get(title)?.some((status) => status !== "passed"))
      fail(`LIVE_GITHUB_OBLIGATION_MISSING:${title}`);
    else if (evidence.obligations?.[obligation] !== true)
      fail(`LIVE_GITHUB_EVIDENCE_MISSING:${obligation}`);
  console.log("Live GitHub evidence report validated.");
}
await main();
