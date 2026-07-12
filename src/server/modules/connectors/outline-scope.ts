import type { Result } from "../../../shared/contracts/result.ts";
import type { ConnectorScope } from "./contract.ts";

const PREFIX = "OUTLINE_COLLECTION:";

export function outlineCollectionReferences(scope: ConnectorScope): ReadonlySet<string> {
  return new Set(
    scope.references
      .filter((reference) => reference.startsWith(PREFIX))
      .map((reference) => reference.slice(PREFIX.length)),
  );
}

export function assertOutlineScope(
  scope: ConnectorScope,
  collectionId: string,
): Result<Readonly<{ collectionId: string }>> {
  return outlineCollectionReferences(scope).has(collectionId)
    ? { ok: true, value: { collectionId } }
    : {
        ok: false,
        error: {
          code: "OUTLINE_SCOPE_DENIED",
          message: "Outline content is outside the current project scope.",
          retry: "NEVER",
        },
      };
}
