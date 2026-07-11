import { readFile, stat } from "node:fs/promises";
import { AUTOMATION_OBLIGATIONS } from "../tests/evidence/automation-matrix.ts";
import { PHASE_EXIT_QUOTES, validateEvidenceEnvelope } from "./evidence/evidence-envelope.ts";

type Row = Readonly<{
  requirement: string;
  status: "LOCAL_PROOF_AVAILABLE" | "IN_PROGRESS_EXTERNAL" | "BLOCKED_ENV" | "PASS";
  testPath: string;
  testName: string;
  proofClass: "LOCAL" | "LIVE";
}>;

export async function validateAutomationEvidence(
  input: unknown,
): Promise<Readonly<{ valid: boolean; reason?: string }>> {
  if (!input || typeof input !== "object")
    return { valid: false, reason: "AUTOMATION_EVIDENCE_INVALID" };
  const value = input as { schemaVersion?: unknown; envelope?: unknown; rows?: readonly Row[] };
  if (value.schemaVersion !== 1 || !Array.isArray(value.rows) || value.rows.length !== 14)
    return { valid: false, reason: "AUTOMATION_EVIDENCE_INVALID" };
  const expected = new Map(AUTOMATION_OBLIGATIONS.map(([id, path, name]) => [id, { path, name }]));
  if (new Set(value.rows.map((row) => row.requirement)).size !== 14)
    return { valid: false, reason: "AUTOMATION_REQUIREMENT_DUPLICATE" };
  for (const row of value.rows) {
    const obligation = expected.get(row.requirement as never);
    if (!obligation || row.testPath !== obligation.path || row.testName !== obligation.name)
      return { valid: false, reason: `AUTOMATION_OBLIGATION_INVALID:${row.requirement}` };
    try {
      if (!(await stat(row.testPath)).isFile())
        return { valid: false, reason: `AUTOMATION_TEST_MISSING:${row.requirement}` };
      const source = await readFile(row.testPath, "utf8");
      if (!source.includes(row.testName))
        return { valid: false, reason: `AUTOMATION_TEST_NAME_STALE:${row.requirement}` };
    } catch {
      return { valid: false, reason: `AUTOMATION_TEST_MISSING:${row.requirement}` };
    }
  }
  const passes = value.rows.some((row) => row.status === "PASS");
  if (passes) {
    const envelope = validateEvidenceEnvelope(value.envelope, {
      phase: "AUTOMATION",
      canonicalExitQuote: PHASE_EXIT_QUOTES.AUTOMATION,
    });
    if (!envelope.valid) return { valid: false, reason: envelope.reasons[0] };
    if (value.rows.some((row) => row.proofClass === "LOCAL" && row.status === "PASS"))
      return { valid: false, reason: "AUTOMATION_LOCAL_PROOF_CANNOT_BE_PASS" };
  }
  return { valid: true };
}

if (import.meta.main) {
  const path = process.argv[2] ?? "docs/evidence/bounded-automation/LOCAL-EVIDENCE.json";
  const result = validateAutomationEvidence(JSON.parse(await readFile(path, "utf8")));
  console.log(JSON.stringify(await result, null, 2));
  if (!(await result).valid) process.exit(1);
}
