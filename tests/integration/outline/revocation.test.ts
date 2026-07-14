import { expect, test } from "bun:test";
import {
  commitReservedOutlineOperation,
  revokeOutlineAuthority,
  type OutlineRevocationCause,
} from "../../../src/server/modules/documents/revocation.ts";
test.each([
  "MEMBER_GRANT",
  "BOT_CONNECTION",
  "CONNECTOR_SCOPE",
  "DOCUMENT_GRANT",
  "MEMBER_OFFBOARDING",
  "RESTORE",
] as const)("denies a reserved write after %s revocation", (cause: OutlineRevocationCause) => {
  const reserved = { connectorEpoch: 1, memberEpoch: 1, grantRevision: 1 };
  const revoked = revokeOutlineAuthority(reserved, cause);
  const result = commitReservedOutlineOperation(reserved, revoked.snapshot, cause);
  expect(result.ok).toBe(false);
});
