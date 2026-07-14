import { expect, test } from "bun:test";
import { revokeOutlineAuthority } from "../../src/server/modules/documents/revocation.ts";
test("document-only revocation does not widen to the connector epoch", () => {
  expect(
    revokeOutlineAuthority(
      { connectorEpoch: 7, memberEpoch: 2, grantRevision: 4 },
      "DOCUMENT_GRANT",
    ),
  ).toEqual({
    cause: "DOCUMENT_GRANT",
    snapshot: { connectorEpoch: 7, memberEpoch: 2, grantRevision: 5 },
    activeWork: "PROPOSAL_ONLY",
  });
});
