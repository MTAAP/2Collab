import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

type Evidence = Readonly<{
  schemaVersion: 2;
  approvalId: string;
  envelope: Readonly<{ buildId: string; repositoryDirty: boolean }>;
  records: readonly Readonly<{
    obligation: string;
    source: "PROVIDER";
    providerResourceId: string;
    collabResourceId: string;
    auditEventId: string;
    providerRevision: string;
  }>[];
}>;

let cached: Promise<Evidence> | undefined;
async function evidence(): Promise<Evidence> {
  if (!cached)
    cached = (async () => {
      const path = process.env.COLLAB_GITHUB_EVIDENCE_RECORD;
      if (!path) throw new Error("LIVE_GITHUB_EVIDENCE_RECORD_REQUIRED");
      const value = JSON.parse(await readFile(path, "utf8")) as Evidence;
      expect(value.schemaVersion).toBe(2);
      expect(value.approvalId).toBe(process.env.COLLAB_GITHUB_APPROVAL_ID);
      expect(value.envelope.buildId).toBe(process.env.COLLAB_GITHUB_BUILD_ID);
      expect(value.envelope.repositoryDirty).toBe(false);
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
    const records = (await evidence()).records.filter((record) => record.obligation === obligation);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: "PROVIDER" });
    expect(records[0]?.providerResourceId).toBeTruthy();
    expect(records[0]?.collabResourceId).toBeTruthy();
    expect(records[0]?.auditEventId).toBeTruthy();
    expect(records[0]?.providerRevision).toMatch(/^(sha:)?[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
  });
}
