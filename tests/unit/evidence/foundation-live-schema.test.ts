import { describe, expect, test } from "bun:test";
import {
  createEmptyFoundationEvidence,
  FoundationEvidenceSchema,
  validateEvidence,
} from "../../../scripts/evidence/foundation-contract.ts";

describe("Foundation live evidence schema", () => {
  test("accepts an honest pending record but does not claim the exit", () => {
    const evidence = createEmptyFoundationEvidence({
      buildId: "build_0123456789abcdef",
      artifactManifestSha256: "a".repeat(64),
      repositoryCommit: "b".repeat(40),
      timezone: "Europe/Berlin",
    });
    expect(FoundationEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(validateEvidence(evidence)).toEqual({ status: "IN_PROGRESS_EXTERNAL" });
  });

  test("rejects manually supplied aggregate status fields", () => {
    const evidence = {
      ...createEmptyFoundationEvidence({
        buildId: "build_0123456789abcdef",
        artifactManifestSha256: "a".repeat(64),
        repositoryCommit: "b".repeat(40),
        timezone: "UTC",
      }),
      status: "PASS",
    };
    expect(FoundationEvidenceSchema.safeParse(evidence).success).toBe(false);
  });
});
