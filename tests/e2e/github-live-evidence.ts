import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

type Evidence = Readonly<{
  schemaVersion: 1;
  approvalId: string;
  reviewer: Readonly<{ memberId: string; reviewedAt: string }>;
  providerResourceIds: readonly string[];
  collabResourceIds: readonly string[];
  auditEventIds: readonly string[];
  obligations: Readonly<Record<string, boolean>>;
}>;

let cached: Promise<Evidence> | undefined;
async function evidence(): Promise<Evidence> {
  if (!cached)
    cached = (async () => {
      const path = process.env.COLLAB_GITHUB_EVIDENCE_RECORD;
      if (!path) throw new Error("LIVE_GITHUB_EVIDENCE_RECORD_REQUIRED");
      const value = JSON.parse(await readFile(path, "utf8")) as Evidence;
      expect(value.schemaVersion).toBe(1);
      expect(value.approvalId).toBe(process.env.COLLAB_GITHUB_APPROVAL_ID);
      expect(value.reviewer.memberId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      expect(Number.isNaN(Date.parse(value.reviewer.reviewedAt))).toBe(false);
      for (const identifiers of [
        value.providerResourceIds,
        value.collabResourceIds,
        value.auditEventIds,
      ]) {
        expect(identifiers.length).toBeGreaterThan(0);
        for (const identifier of identifiers)
          expect(identifier).toMatch(/^[A-Za-z0-9_:#/-]{1,256}$/);
      }
      return value;
    })();
  return cached;
}

export function liveGitHubObligation(title: string, obligation: string): void {
  test(title, async () => {
    test.skip(
      process.env.COLLAB_LIVE_GITHUB !== "1" || !process.env.COLLAB_GITHUB_APPROVAL_ID,
      "LIVE_GITHUB_NOT_AUTHORIZED",
    );
    expect((await evidence()).obligations[obligation]).toBe(true);
  });
}
