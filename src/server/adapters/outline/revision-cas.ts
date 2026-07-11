import type { AuthoredDocumentPatch } from "../../../shared/contracts/outline.ts";
import type { Result } from "../../../shared/contracts/result.ts";

export function staleOutlineRevision(
  patch: AuthoredDocumentPatch,
  currentRevision: string,
): Result<never> {
  return {
    ok: false,
    error: {
      code: "SOURCE_REVISION_STALE",
      message: "Source revision is stale.",
      retry: "REFRESH",
      details: { authoredPatchDigest: patch.digest, currentRevision },
    },
  };
}
