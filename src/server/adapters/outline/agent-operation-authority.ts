import type {
  OutlineDocumentProjection,
  OutlineMutation,
} from "../../../shared/contracts/outline.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { OutlineContentPort } from "../../modules/connectors/outline-content-port.ts";
import type {
  ExactRevisionMutation,
  Observed,
  SourceConnector,
} from "../../modules/connectors/contract.ts";
import { authorizeDocumentGrant } from "../../modules/documents/write-grants.ts";
import type { createOutlineDocumentRepository } from "../../modules/documents/repository.ts";

type Repository = ReturnType<typeof createOutlineDocumentRepository>;
type ConnectorAuthority = Readonly<{
  mutateAsAttempt<P, M>(
    connector: SourceConnector<string, P, M>,
    input: Readonly<{
      authorizationId: string;
      authorizationProof: string;
      reference: string;
      operation: string;
      command: ExactRevisionMutation<M>;
    }>,
  ): Promise<Result<Observed<P>>>;
}>;

export function createOutlineAgentOperationAuthority(
  dependencies: Readonly<{
    connectorAuthority: ConnectorAuthority;
    repository: Repository;
    outline: OutlineContentPort;
    clock: () => number;
  }>,
) {
  return {
    async edit(
      input: Readonly<{
        grantId: string;
        grantRevision: number;
        runId: string;
        documentId: string;
        authorizationId: string;
        authorizationProof: string;
        command: ExactRevisionMutation<OutlineMutation>;
      }>,
    ): Promise<Result<Observed<OutlineDocumentProjection>>> {
      const authorize = () => {
        const loaded = dependencies.repository.loadGrant(input.grantId);
        if (!loaded.ok) return loaded;
        return authorizeDocumentGrant(loaded.value, {
          runId: input.runId,
          documentId: input.documentId,
          connectorEpoch: input.command.connectorEpoch,
          grantRevision: input.grantRevision,
          sourceRevision:
            input.command.precondition.kind === "EXACT_REVISION"
              ? input.command.precondition.sourceRevision
              : "",
          comparableDigest:
            input.command.precondition.kind === "EXACT_REVISION"
              ? input.command.precondition.comparableDigest
              : "",
          now: dependencies.clock(),
        });
      };
      const initial = authorize();
      if (!initial.ok) return initial;
      const connector: SourceConnector<string, OutlineDocumentProjection, OutlineMutation> = {
        async inspect() {
          return {
            ok: false,
            error: {
              code: "OUTLINE_INSPECTION_UNAVAILABLE",
              message: "Outline inspection is unavailable.",
              retry: "NEVER",
            },
          };
        },
        async mutate(authorization, command) {
          const current = authorize();
          if (!current.ok) return current;
          return dependencies.outline.mutate(authorization, command);
        },
        async *scan() {
          yield {
            ok: false,
            error: {
              code: "OUTLINE_RECONCILIATION_UNAVAILABLE",
              message: "Outline reconciliation is unavailable.",
              retry: "NEVER",
            },
          };
        },
      };
      const result = await dependencies.connectorAuthority.mutateAsAttempt(connector, {
        authorizationId: input.authorizationId,
        authorizationProof: input.authorizationProof,
        reference: input.documentId,
        operation: "EDIT_CONTENT",
        command: input.command,
      });
      if (!result.ok) return result;
      const advanced = dependencies.repository.advanceGrant(
        input.grantId,
        input.grantRevision,
        input.documentId,
        result.value.sourceRevision,
        result.value.comparableDigest,
      );
      return advanced.ok ? result : advanced;
    },
  };
}
