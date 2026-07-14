import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type {
  OutlineDocumentProjection,
  OutlineMutation,
} from "../../../shared/contracts/outline.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { OutlineContentPort } from "../../modules/connectors/outline-content-port.ts";
import type {
  ConnectorScope,
  ExactRevisionMutation,
  Observed,
  SourceConnector,
} from "../../modules/connectors/contract.ts";
import type { OutlineMemberMutationAuthorityPort } from "../../modules/documents/human-editing.ts";

type ConnectorAuthority = Readonly<{
  currentScope(projectId: string, connectorId: string): Promise<Result<ConnectorScope>>;
  mutateAsMember<P, M>(
    connector: SourceConnector<string, P, M>,
    input: Readonly<{
      actor: MemberActor;
      reference: string;
      operation: string;
      command: ExactRevisionMutation<M>;
    }>,
  ): Promise<Result<Observed<P>>>;
}>;

function mutationConnector(
  outline: OutlineContentPort,
): SourceConnector<string, OutlineDocumentProjection, OutlineMutation> {
  return {
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
    mutate: (authorization, command) => outline.mutate(authorization, command),
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
}

/** Binds human Outline writes to the shared ConnectorAuthority browser-session and exact-revision engine. */
export function bindOutlineMemberMutationAuthority(
  connectorAuthority: ConnectorAuthority,
  actor: MemberActor,
): OutlineMemberMutationAuthorityPort {
  return {
    currentScope: (projectId, connectorId) =>
      connectorAuthority.currentScope(projectId, connectorId),
    mutate(outline, input) {
      if (input.memberId !== actor.memberId)
        return Promise.resolve({
          ok: false,
          error: {
            code: "MEMBER_AUTHORITY_MISMATCH",
            message: "Member authority is denied.",
            retry: "NEVER",
          },
        });
      return connectorAuthority.mutateAsMember(mutationConnector(outline), {
        actor,
        reference: input.reference,
        operation: input.operation,
        command: input.command,
      });
    },
  };
}
