import type { Result } from "../../../shared/contracts/result.ts";
export type OutlineRevocationCause =
  | "MEMBER_GRANT"
  | "BOT_CONNECTION"
  | "CONNECTOR_SCOPE"
  | "DOCUMENT_GRANT"
  | "MEMBER_OFFBOARDING"
  | "RESTORE";
export type OutlineAuthoritySnapshot = Readonly<{
  connectorEpoch: number;
  memberEpoch: number;
  grantRevision: number;
}>;
export function revokeOutlineAuthority(
  snapshot: OutlineAuthoritySnapshot,
  cause: OutlineRevocationCause,
): Readonly<{
  cause: OutlineRevocationCause;
  snapshot: OutlineAuthoritySnapshot;
  activeWork: "WAITING" | "PROPOSAL_ONLY";
}> {
  const broad = cause !== "DOCUMENT_GRANT";
  return {
    cause,
    snapshot: {
      connectorEpoch: broad ? snapshot.connectorEpoch + 1 : snapshot.connectorEpoch,
      memberEpoch:
        cause === "MEMBER_GRANT" || cause === "MEMBER_OFFBOARDING" || cause === "RESTORE"
          ? snapshot.memberEpoch + 1
          : snapshot.memberEpoch,
      grantRevision:
        cause === "DOCUMENT_GRANT" || broad ? snapshot.grantRevision + 1 : snapshot.grantRevision,
    },
    activeWork: cause === "DOCUMENT_GRANT" ? "PROPOSAL_ONLY" : "WAITING",
  };
}
export function commitReservedOutlineOperation(
  reserved: OutlineAuthoritySnapshot,
  current: OutlineAuthoritySnapshot,
  cause: OutlineRevocationCause,
): Result<Readonly<{ committed: true }>> {
  if (JSON.stringify(reserved) !== JSON.stringify(current))
    return {
      ok: false,
      error: {
        code: cause === "DOCUMENT_GRANT" ? "DOCUMENT_GRANT_REVOKED" : "CONNECTOR_SCOPE_REVOKED",
        message: "Outline authority was revoked.",
        retry: "EXPLICIT_RESUME",
      },
    };
  return { ok: true, value: { committed: true } };
}
export function scanForbiddenCanaries(
  stores: readonly Readonly<{ id: string; bytes: string }>[],
  canaries: readonly string[],
): Result<Readonly<{ scanned: number }>> {
  for (const store of stores)
    for (const canary of canaries) {
      const variants = [
        canary,
        JSON.stringify(canary),
        encodeURIComponent(canary),
        Buffer.from(canary).toString("base64"),
      ];
      if (variants.some((value) => store.bytes.includes(value)))
        return {
          ok: false,
          error: {
            code: "OUTLINE_CANARY_FOUND",
            message: `Forbidden data was found in ${store.id}.`,
            retry: "NEVER",
          },
        };
    }
  return { ok: true, value: { scanned: stores.length } };
}
