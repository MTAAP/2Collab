import { expect, test } from "@playwright/test";
import { authorizeDocumentGrant } from "../../src/server/modules/documents/write-grants.ts";
import { revokeOutlineAuthority } from "../../src/server/modules/documents/revocation.ts";
test("fixture-backed collaboration keeps exact grant and revocation boundaries", async () => {
  const grant = {
    grantId: "grant" as never,
    projectId: "project" as never,
    connectorId: "connector" as never,
    runId: "run" as never,
    grantorMemberId: "member" as never,
    connectorEpoch: 1,
    grantRevision: 1,
    documents: [
      {
        documentId: "doc" as never,
        sourceRevision: "1",
        comparableDigest: "a".repeat(64) as never,
        documentRevision: 1,
      },
    ],
    operations: ["EDIT_CONTENT" as const],
    createdAt: 0,
    expiresAt: 100,
  };
  expect(
    authorizeDocumentGrant(grant, {
      runId: "run",
      documentId: "doc",
      connectorEpoch: 1,
      grantRevision: 1,
      sourceRevision: "1",
      comparableDigest: "a".repeat(64),
      now: 1,
    }).ok,
  ).toBe(true);
  expect(
    revokeOutlineAuthority(
      { connectorEpoch: 1, memberEpoch: 1, grantRevision: 1 },
      "DOCUMENT_GRANT",
    ).activeWork,
  ).toBe("PROPOSAL_ONLY");
});
