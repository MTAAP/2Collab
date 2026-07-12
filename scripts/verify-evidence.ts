import { readFile, stat } from "node:fs/promises";
import {
  localFoundationMatrix,
  type FoundationRequirementProof,
} from "../tests/evidence/foundation-matrix.ts";

const acceptancePath = "docs/acceptance/ACCEPTANCE-MATRIX.md";

function canonicalFoundationIds(source: string): string[] {
  return [...source.matchAll(/^\| `?(FND-\d{3})`? \|/gm)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

export async function validateFoundationMatrix(
  matrix: readonly FoundationRequirementProof[],
): Promise<{ requirementCount: number; obligationCount: number }> {
  const canonical = canonicalFoundationIds(await readFile(acceptancePath, "utf8"));
  const actual = matrix.map((row) => row.requirementId);
  if (canonical.length !== 19 || new Set(canonical).size !== canonical.length)
    throw new Error("CANONICAL_FOUNDATION_MATRIX_INVALID");
  if (actual.join("|") !== canonical.join("|"))
    throw new Error("FOUNDATION_REQUIREMENT_ORDER_INVALID");
  const obligationIds = new Set<string>();
  let count = 0;
  for (const row of matrix) {
    if (row.proofObligations.length === 0 && row.statusRule !== "EXTERNAL_ONLY")
      throw new Error(`FOUNDATION_LOCAL_PROOF_MISSING:${row.requirementId}`);
    if (row.statusRule === "ALL_LOCAL" && row.externalProof.length > 0)
      throw new Error(`FOUNDATION_STATUS_RULE_INVALID:${row.requirementId}`);
    for (const obligation of row.proofObligations) {
      if (obligationIds.has(obligation.id))
        throw new Error(`FOUNDATION_OBLIGATION_DUPLICATE:${obligation.id}`);
      obligationIds.add(obligation.id);
      if (!/\.((test\.ts)|(spec\.ts))$/.test(obligation.testPath))
        throw new Error(`FOUNDATION_TEST_REFERENCE_NOT_FILE:${obligation.id}`);
      const metadata = await stat(obligation.testPath);
      if (!metadata.isFile())
        throw new Error(`FOUNDATION_TEST_REFERENCE_NOT_FILE:${obligation.id}`);
      const source = await readFile(obligation.testPath, "utf8");
      if (
        !source.includes(`test("${obligation.testName}"`) &&
        !source.includes(`test(\`${obligation.testName}\``)
      )
        throw new Error(`FOUNDATION_TEST_NAME_STALE:${obligation.id}`);
      count += 1;
    }
  }
  return { requirementCount: matrix.length, obligationCount: count };
}

if (import.meta.main) {
  try {
    const result = await validateFoundationMatrix(localFoundationMatrix);
    console.log(JSON.stringify({ status: "LOCAL_REGISTRY_VALID", ...result }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "EVIDENCE_VERIFICATION_FAILED");
    process.exit(1);
  }
}
