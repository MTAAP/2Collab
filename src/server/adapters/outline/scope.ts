import type { Result } from "../../../shared/contracts/result.ts";
import type { ConnectorScope } from "../../modules/connectors/contract.ts";

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
  if (!outlineCollectionReferences(scope).has(collectionId)) {
    return {
      ok: false,
      error: {
        code: "OUTLINE_SCOPE_DENIED",
        message: "Outline content is outside the current project scope.",
        retry: "NEVER",
      },
    };
  }
  return { ok: true, value: { collectionId } };
}
