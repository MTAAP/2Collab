import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AUTOMATION_REQUIREMENTS,
  type AutomationObligation,
  validateAutomationRegistryAgainstMatrix,
} from "../tests/evidence/automation-matrix.ts";
import { PHASE_EXIT_QUOTES, validateEvidenceEnvelope } from "./evidence/evidence-envelope.ts";

type AutomationStatus =
  | "NOT_RUN"
  | "IN_PROGRESS_LOCAL"
  | "LOCAL_PROOF_AVAILABLE"
  | "IN_PROGRESS_EXTERNAL"
  | "BLOCKED_ENV"
  | "PASS"
  | "FAIL";

type Row = Readonly<{
  requirement: string;
  status: AutomationStatus;
  proofClass: "LOCAL" | "LIVE";
  obligationIds: readonly string[];
  reportIds: readonly string[];
}>;

type FrozenFile = Readonly<{ path: string; sha256: string }>;
type FrozenBuild = Readonly<{
  buildId: string;
  repositoryRevision: string;
  artifact: FrozenFile;
  lockfile: FrozenFile;
  manifest: FrozenFile;
}>;

type Report = Readonly<{
  reportId: string;
  path: string;
  sha256: string;
  runner: "BUN" | "PLAYWRIGHT" | "DRILL" | "OPERATOR";
}>;

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fileDigest(path: string): Promise<string | undefined> {
  try {
    return sha256(await readFile(path));
  } catch {
    return undefined;
  }
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  return attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
}

function passedJunitCases(xml: string): Set<string> | undefined {
  const root = xml.match(/<testsuites\b([^>]*)>/)?.[1];
  if (!root) return undefined;
  if (
    Number(xmlAttribute(root, "failures") ?? "0") !== 0 ||
    Number(xmlAttribute(root, "errors") ?? "0") !== 0 ||
    Number(xmlAttribute(root, "skipped") ?? "0") !== 0
  )
    return undefined;
  const cases = new Set<string>();
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    if (/<(?:failure|error|skipped)\b/.test(body)) return undefined;
    const path = xmlAttribute(attributes, "file");
    const name = xmlAttribute(attributes, "name");
    if (path && name) cases.add(`${decodeXml(path)}\0${decodeXml(name)}`);
  }
  return cases.size ? cases : undefined;
}

type PlaywrightSuite = Readonly<{
  specs?: readonly Readonly<{
    title?: string;
    file?: string;
    tests?: readonly Readonly<{
      status?: string;
      results?: readonly Readonly<{ status?: string }>[];
    }>[];
  }>[];
  suites?: readonly PlaywrightSuite[];
}>;

function passedPlaywrightCases(json: string): Set<string> | undefined {
  let report: { suites?: readonly PlaywrightSuite[]; errors?: readonly unknown[] };
  try {
    report = JSON.parse(json);
  } catch {
    return undefined;
  }
  if ((report.errors?.length ?? 0) > 0) return undefined;
  const cases = new Set<string>();
  const visit = (suite: PlaywrightSuite) => {
    for (const spec of suite.specs ?? []) {
      const tests = spec.tests ?? [];
      if (
        spec.file &&
        spec.title &&
        tests.length > 0 &&
        tests.every(
          (test) =>
            test.status === "expected" &&
            (test.results?.length ?? 0) > 0 &&
            test.results?.every((result) => result.status === "passed"),
        )
      )
        cases.add(`${spec.file}\0${spec.title}`);
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return cases.size ? cases : undefined;
}

async function loadPassedCases(report: Report): Promise<Set<string> | undefined> {
  let contents: string;
  try {
    contents = await readFile(report.path, "utf8");
  } catch {
    return undefined;
  }
  if (sha256(contents) !== report.sha256) return undefined;
  if (report.runner === "BUN") return passedJunitCases(contents);
  if (report.runner === "PLAYWRIGHT") return passedPlaywrightCases(contents);
  return undefined;
}

async function validateFrozenBuild(
  frozen: FrozenBuild | undefined,
  envelope: ReturnType<typeof validateEvidenceEnvelope>["envelope"],
): Promise<boolean> {
  if (!frozen || !envelope) return false;
  if (
    frozen.buildId !== envelope.buildId ||
    frozen.repositoryRevision !== envelope.repositoryRevision ||
    frozen.artifact.sha256 !== envelope.artifactSha256 ||
    frozen.lockfile.sha256 !== envelope.lockfileSha256 ||
    frozen.manifest.sha256 !== envelope.manifestSha256
  )
    return false;
  return (
    (await fileDigest(frozen.artifact.path)) === frozen.artifact.sha256 &&
    (await fileDigest(frozen.lockfile.path)) === frozen.lockfile.sha256 &&
    (await fileDigest(frozen.manifest.path)) === frozen.manifest.sha256
  );
}

function exactObligationSet(row: Row, obligations: readonly AutomationObligation[]): boolean {
  const expected = obligations.map(({ id }) => id);
  return (
    row.obligationIds.length === expected.length &&
    new Set(row.obligationIds).size === expected.length &&
    expected.every((id) => row.obligationIds.includes(id))
  );
}

export async function validateAutomationEvidence(
  input: unknown,
): Promise<Readonly<{ valid: boolean; reason?: string }>> {
  const registry = await validateAutomationRegistryAgainstMatrix();
  if (!registry.valid) return registry;
  if (!input || typeof input !== "object")
    return { valid: false, reason: "AUTOMATION_EVIDENCE_INVALID" };
  const value = input as {
    schemaVersion?: unknown;
    frozenBuild?: FrozenBuild;
    envelope?: unknown;
    rows?: readonly Row[];
  };
  if (value.schemaVersion !== 2 || !Array.isArray(value.rows) || value.rows.length !== 14)
    return { valid: false, reason: "AUTOMATION_EVIDENCE_INVALID" };
  if (new Set(value.rows.map((row) => row.requirement)).size !== 14)
    return { valid: false, reason: "AUTOMATION_REQUIREMENT_DUPLICATE" };

  const byRequirement = new Map(AUTOMATION_REQUIREMENTS.map((entry) => [entry.id, entry]));
  for (const row of value.rows) {
    const expected = byRequirement.get(row.requirement as `AUT-${string}`);
    if (
      !expected ||
      !Array.isArray(row.obligationIds) ||
      !Array.isArray(row.reportIds) ||
      !exactObligationSet(row, expected.obligations)
    )
      return { valid: false, reason: `AUTOMATION_OBLIGATION_SET_INVALID:${row.requirement}` };
    if (expected.id === "AUT-014" ? row.proofClass !== "LIVE" : row.proofClass !== "LOCAL")
      return { valid: false, reason: `AUTOMATION_PROOF_CLASS_INVALID:${row.requirement}` };
    if (row.proofClass === "LOCAL" && row.status === "PASS")
      return { valid: false, reason: "AUTOMATION_LOCAL_PROOF_CANNOT_BE_PASS" };
  }

  const claimed = value.rows.filter(
    ({ status }) => status === "LOCAL_PROOF_AVAILABLE" || status === "PASS",
  );
  if (claimed.length === 0) return { valid: true };

  const envelopeResult = validateEvidenceEnvelope(value.envelope, {
    phase: "AUTOMATION",
    buildId: value.frozenBuild?.buildId,
    canonicalExitQuote: PHASE_EXIT_QUOTES.AUTOMATION,
  });
  if (!envelopeResult.valid) return { valid: false, reason: envelopeResult.reasons[0] };
  if (!(await validateFrozenBuild(value.frozenBuild, envelopeResult.envelope)))
    return { valid: false, reason: "AUTOMATION_FROZEN_BUILD_INVALID" };

  const reports = new Map(
    (envelopeResult.envelope?.testReports ?? []).map((report) => [report.reportId, report]),
  );
  const passedByReport = new Map<string, Set<string>>();
  for (const row of claimed) {
    if (row.reportIds.length === 0 || new Set(row.reportIds).size !== row.reportIds.length)
      return { valid: false, reason: `AUTOMATION_REPORT_SET_INVALID:${row.requirement}` };
    const expected = byRequirement.get(row.requirement as `AUT-${string}`);
    if (!expected)
      return { valid: false, reason: `AUTOMATION_REQUIREMENT_UNKNOWN:${row.requirement}` };
    const selected: Readonly<{ report: Report; cases: Set<string> }>[] = [];
    for (const reportId of row.reportIds) {
      const report = reports.get(reportId);
      if (!report) return { valid: false, reason: `AUTOMATION_REPORT_UNKNOWN:${row.requirement}` };
      let cases = passedByReport.get(reportId);
      if (!cases) {
        cases = await loadPassedCases(report);
        if (!cases)
          return { valid: false, reason: `AUTOMATION_REPORT_NOT_PASSED:${row.requirement}` };
        passedByReport.set(reportId, cases);
      }
      selected.push({ report, cases });
    }
    for (const obligation of expected.obligations) {
      if (
        !selected.some(
          ({ report, cases }) =>
            report.runner === obligation.runner &&
            cases.has(`${obligation.testPath}\0${obligation.testName}`),
        )
      )
        return { valid: false, reason: `AUTOMATION_OBLIGATION_NOT_PASSED:${obligation.id}` };
    }
  }
  return { valid: true };
}

if (import.meta.main) {
  const path = process.argv[2] ?? "docs/evidence/bounded-automation/LOCAL-EVIDENCE.json";
  const result = await validateAutomationEvidence(JSON.parse(await readFile(path, "utf8")));
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exit(1);
}
