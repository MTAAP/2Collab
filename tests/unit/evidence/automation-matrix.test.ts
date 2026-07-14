import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  AUTOMATION_REQUIREMENTS,
  validateAutomationRegistryAgainstMatrix,
} from "../../evidence/automation-matrix.ts";
import { validateAutomationEvidence } from "../../../scripts/automation-evidence.ts";
import { PHASE_EXIT_QUOTES } from "../../../scripts/evidence/evidence-envelope.ts";

test("registry maps all fourteen IDs to their canonical behavior and required levels", async () => {
  expect(AUTOMATION_REQUIREMENTS).toHaveLength(14);
  expect(new Set(AUTOMATION_REQUIREMENTS.map(({ id }) => id)).size).toBe(14);
  expect(await validateAutomationRegistryAgainstMatrix()).toEqual({ valid: true });
  expect(AUTOMATION_REQUIREMENTS.find(({ id }) => id === "AUT-001")).toMatchObject({
    anchor: "team-run-templates-v1",
    testLevel: "Unit + integration",
  });
  expect(
    AUTOMATION_REQUIREMENTS.find(({ id }) => id === "AUT-001")?.obligations.map(
      ({ testPath }) => testPath,
    ),
  ).toContain("tests/unit/templates/portable-template.test.ts");
  expect(AUTOMATION_REQUIREMENTS.find(({ id }) => id === "AUT-014")).toMatchObject({
    anchor: "dogfood-delivery-slices-and-exit-criteria",
    testLevel: "Live dogfood",
  });
});

test("registry validation rejects displaced and self-authored canonical mappings", async () => {
  const displaced = AUTOMATION_REQUIREMENTS.map((entry, index, all) => ({
    ...entry,
    requirement: all[(index + 1) % all.length]?.requirement ?? "missing",
  }));
  expect((await validateAutomationRegistryAgainstMatrix(displaced)).valid).toBe(false);
  const renamed = AUTOMATION_REQUIREMENTS.map((entry) =>
    entry.id === "AUT-003" ? { ...entry, observable: "A test we wrote passes." } : entry,
  );
  expect((await validateAutomationRegistryAgainstMatrix(renamed)).valid).toBe(false);
});

test("the checked-in ledger is honest when no frozen reports are attached", async () => {
  const input = await Bun.file("docs/evidence/bounded-automation/LOCAL-EVIDENCE.json").json();
  expect(await validateAutomationEvidence(input)).toEqual({ valid: true });
  expect(
    input.rows.filter((row: { status: string }) => row.status === "LOCAL_PROOF_AVAILABLE"),
  ).toHaveLength(0);
});

test("source text cannot promote an obligation without a matching passed report", async () => {
  const input = await Bun.file("docs/evidence/bounded-automation/LOCAL-EVIDENCE.json").json();
  const promoted = {
    ...input,
    rows: input.rows.map((row: { requirement: string }) =>
      row.requirement === "AUT-001" ? { ...row, status: "LOCAL_PROOF_AVAILABLE" } : row,
    ),
  };
  expect((await validateAutomationEvidence(promoted)).valid).toBe(false);
});

test("local proof consumes passed JUnit cases and matching frozen-build digests", async () => {
  const directory = await mkdtemp("automation-evidence-");
  try {
    const requirement = AUTOMATION_REQUIREMENTS.find(({ id }) => id === "AUT-001");
    if (!requirement) throw new Error("AUT001_REGISTRY_MISSING");
    const reportPath = join(directory, "bun.xml");
    const artifactPath = join(directory, "artifact.tar");
    const lockPath = join(directory, "bun.lock");
    const manifestPath = join(directory, "MANIFEST.sha256");
    const xml = `<?xml version="1.0"?><testsuites tests="${requirement.obligations.length}" failures="0" skipped="0"><testsuite>${requirement.obligations
      .map(
        ({ testPath, testName }) =>
          `<testcase name="${testName}" file="${testPath}" classname="automation" />`,
      )
      .join("")}</testsuite></testsuites>`;
    await writeFile(reportPath, xml);
    await writeFile(artifactPath, "artifact");
    await writeFile(lockPath, "lock");
    await writeFile(manifestPath, "manifest");
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const buildId = "automation_build_1";
    const reportId = "automation_bun_report";
    const input = {
      schemaVersion: 2,
      frozenBuild: {
        buildId,
        repositoryRevision: "a".repeat(40),
        artifact: { path: artifactPath, sha256: digest("artifact") },
        lockfile: { path: lockPath, sha256: digest("lock") },
        manifest: { path: manifestPath, sha256: digest("manifest") },
      },
      envelope: {
        schemaVersion: 1,
        phase: "AUTOMATION",
        buildId,
        repositoryRevision: "a".repeat(40),
        repositoryDirty: false,
        artifactSha256: digest("artifact"),
        lockfileSha256: digest("lock"),
        manifestSha256: digest("manifest"),
        testReports: [
          {
            reportId,
            buildId,
            path: reportPath,
            sha256: digest(xml),
            runner: "BUN",
            generatedAt: "2026-07-11T12:00:00Z",
            result: "PASSED",
            skipped: 0,
            synthetic: false,
          },
        ],
        reviewers: [{ memberId: "member_reviewer", reviewedAt: "2026-07-11T13:00:00Z" }],
        canonicalExitQuote: PHASE_EXIT_QUOTES.AUTOMATION,
      },
      rows: AUTOMATION_REQUIREMENTS.map(({ id, obligations }) => ({
        requirement: id,
        proofClass: id === "AUT-014" ? "LIVE" : "LOCAL",
        status:
          id === "AUT-001"
            ? "LOCAL_PROOF_AVAILABLE"
            : id === "AUT-014"
              ? "IN_PROGRESS_EXTERNAL"
              : "NOT_RUN",
        obligationIds: obligations.map(({ id: obligationId }) => obligationId),
        reportIds: id === "AUT-001" ? [reportId] : [],
      })),
    };
    expect(await validateAutomationEvidence(input)).toEqual({ valid: true });
    const failedXml = xml.replace('failures="0"', 'failures="1"');
    await writeFile(reportPath, failedXml);
    expect((await validateAutomationEvidence(input)).valid).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
