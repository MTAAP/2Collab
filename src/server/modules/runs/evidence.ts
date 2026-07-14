import type { Result } from "../../../shared/contracts/result.ts";
import { type EvidenceRecord, EvidenceRecordSchema } from "../../../shared/contracts/runs.ts";

export function createEvidence(input: unknown): Result<EvidenceRecord> {
  const parsed = EvidenceRecordSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data as EvidenceRecord }
    : {
        ok: false,
        error: { code: "EVIDENCE_INVALID", message: "Evidence is invalid.", retry: "NEVER" },
      };
}
