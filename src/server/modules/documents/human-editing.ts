import type {
  AuthoredDocumentPatch,
  OutlineDocumentProjection,
  OutlineMutation,
} from "../../../shared/contracts/outline.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { ConnectorScope, ExactRevisionMutation, Observed } from "../connectors/contract.ts";
import type { OutlineContentPort } from "../connectors/outline-content-port.ts";
import { assertOutlineScope } from "../connectors/outline-scope.ts";
import {
  memberCreateMutation,
  memberEditMutation,
  staleOutlineRevision,
} from "./human-editing-policy.ts";

export interface OutlineMemberMutationAuthorityPort {
  currentScope(projectId: string, connectorId: string): Promise<Result<ConnectorScope>>;
  mutate(
    outline: OutlineContentPort,
    input: Readonly<{
      memberId: string;
      reference: string;
      operation: "CREATE_DOCUMENT" | "EDIT_CONTENT";
      command: ExactRevisionMutation<OutlineMutation>;
    }>,
  ): Promise<Result<Observed<OutlineDocumentProjection>>>;
}

type BaseCommand = Readonly<{
  memberId: string;
  projectId: string;
  connectorId: string;
  connectorEpoch: number;
  workspaceId: string;
  idempotencyKey: string;
}>;

export function createHumanDocumentEditing(
  dependencies: Readonly<{
    outline: OutlineContentPort;
    authority: OutlineMemberMutationAuthorityPort;
    requireDelegatedMember(
      memberId: string,
      connectorId: string,
    ): Promise<Result<Readonly<{ outlineUserId: string }>>>;
  }>,
) {
  return {
    async createDocumentAsMember(
      command: BaseCommand & Readonly<{ collectionId: string; title: string; body: string }>,
    ): Promise<Result<Observed<OutlineDocumentProjection>>> {
      const delegated = await dependencies.requireDelegatedMember(
        command.memberId,
        command.connectorId,
      );
      if (!delegated.ok) return delegated;
      const scope = await dependencies.authority.currentScope(
        command.projectId,
        command.connectorId,
      );
      if (!scope.ok) return scope;
      const allowed = assertOutlineScope(scope.value, command.collectionId);
      if (!allowed.ok) return allowed;
      const mutation = memberCreateMutation(command);
      return dependencies.authority.mutate(dependencies.outline, {
        memberId: command.memberId,
        reference: `OUTLINE_COLLECTION:${command.collectionId}`,
        operation: "CREATE_DOCUMENT",
        command: mutation,
      });
    },

    async editDocumentAsMember(
      command: BaseCommand &
        Readonly<{
          documentId: string;
          expectedRevision: string;
          expectedDigest: string;
          authoredPatch: AuthoredDocumentPatch;
        }>,
    ): Promise<Result<Observed<OutlineDocumentProjection>>> {
      const delegated = await dependencies.requireDelegatedMember(
        command.memberId,
        command.connectorId,
      );
      if (!delegated.ok) return delegated;
      const scope = await dependencies.authority.currentScope(
        command.projectId,
        command.connectorId,
      );
      if (!scope.ok) return scope;
      const reference = {
        kind: "OUTLINE_DOCUMENT" as const,
        workspaceId: command.workspaceId as never,
        documentId: command.documentId as never,
      };
      const current = await dependencies.outline.read(scope.value, reference);
      if (!current.ok) return current;
      if (
        current.value.sourceRevision !== command.expectedRevision ||
        current.value.value.comparableDigest !== command.expectedDigest
      )
        return staleOutlineRevision(command.authoredPatch, current.value.sourceRevision);
      const mutation = memberEditMutation({
        ...command,
        sourceRevision: command.expectedRevision,
        comparableDigest: command.expectedDigest,
      });
      return dependencies.authority.mutate(dependencies.outline, {
        memberId: command.memberId,
        reference: command.documentId,
        operation: "EDIT_CONTENT",
        command: mutation,
      });
    },
  };
}
