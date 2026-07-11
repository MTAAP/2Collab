import { expect, test } from "bun:test";
import { AUTOMATION_OBLIGATIONS } from "../../evidence/automation-matrix.ts";
import { validateAutomationEvidence } from "../../../scripts/automation-evidence.ts";

test("automation registry has fourteen unique machine-readable obligations", async () => {
  expect(AUTOMATION_OBLIGATIONS).toHaveLength(14);
  expect(new Set(AUTOMATION_OBLIGATIONS.map(([id]) => id)).size).toBe(14);
  const input = await Bun.file("docs/evidence/bounded-automation/LOCAL-EVIDENCE.json").json();
  expect((await validateAutomationEvidence(input)).valid).toBe(true);
});

test("automation evidence cannot promote local toggles or unbound proof to PASS", async () => {
  const input = await Bun.file("docs/evidence/bounded-automation/LOCAL-EVIDENCE.json").json();
  const promoted = {
    ...input,
    rows: input.rows.map((row: object) => ({ ...row, status: "PASS" })),
  };
  expect((await validateAutomationEvidence(promoted)).valid).toBe(false);
});
