import { createHash } from "node:crypto";
import type {
  OutlineDocumentProjection,
  OutlineReadResult,
  OutlineReference,
} from "../../../shared/contracts/outline.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { ConnectorScope, EphemeralObserved } from "../connectors/contract.ts";
import type { OutlineContentPort } from "../connectors/outline-content-port.ts";
import type { AuthorizedOutlineActor } from "../federated-search/contract.ts";

export type OutlineAccessResult = "ALLOWED" | "STALE" | "UNAVAILABLE" | "FORBIDDEN" | "REDACTED";
export interface OutlineAccessProvenancePort {
  record(
    input: Readonly<{
      actor: AuthorizedOutlineActor;
      projectId: string;
      connectorId: string;
      connectorEpoch: number;
      documentId?: string;
      correlationDigest?: string;
      observedRevision?: string;
      result: OutlineAccessResult;
    }>,
  ): Promise<void>;
}
export interface OutlineReferenceProjectionPort {
  upsert(input: OutlineDocumentProjection): Promise<void>;
}

export type AuthorizedReferenceRead = Readonly<{
  actor: AuthorizedOutlineActor;
  scope: ConnectorScope;
  reference: OutlineReference;
}>;

const unavailable = (): Result<never> => ({
  ok: false,
  error: {
    code: "CONTEXT_REFERENCE_UNAVAILABLE",
    message: "Context reference is unavailable.",
    retry: "REFRESH",
  },
});

export function createOutlineReferenceProvider(
  dependencies: Readonly<{
    outline: OutlineContentPort;
    provenance: OutlineAccessProvenancePort;
    projections: OutlineReferenceProjectionPort;
  }>,
) {
  return {
    async get(
      command: AuthorizedReferenceRead,
    ): Promise<Result<EphemeralObserved<OutlineReadResult>>> {
      const result = await dependencies.outline.read(command.scope, command.reference);
      if (!result.ok) {
        await dependencies.provenance.record({
          actor: command.actor,
          projectId: command.scope.projectId,
          connectorId: command.scope.connectorId,
          connectorEpoch: command.scope.connectorEpoch,
          correlationDigest: createHash("sha256")
            .update(command.reference.documentId)
            .digest("hex"),
          result: "FORBIDDEN",
        });
        return unavailable();
      }
      const { body: _ephemeralBody, ...safeProjection } = result.value.value;
      await dependencies.projections.upsert(safeProjection);
      await dependencies.provenance.record({
        actor: command.actor,
        projectId: command.scope.projectId,
        connectorId: command.scope.connectorId,
        connectorEpoch: command.scope.connectorEpoch,
        documentId: command.reference.documentId,
        observedRevision: result.value.sourceRevision,
        result: "ALLOWED",
      });
      return result;
    },
  };
}
