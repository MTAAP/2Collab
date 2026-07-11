import { createHash } from "node:crypto";
import type { AuthoredDocumentPatch, OutlineMutation } from "../../../shared/contracts/outline.ts";
import type { ExactRevisionMutation } from "../../modules/connectors/contract.ts";

const actionDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex") as never;

export function memberCreateMutation(
  input: Readonly<{
    projectId: string;
    connectorId: string;
    connectorEpoch: number;
    idempotencyKey: string;
    collectionId: string;
    title: string;
    body: string;
  }>,
): ExactRevisionMutation<OutlineMutation> {
  const mutation = {
    kind: "CREATE_DOCUMENT_AS_MEMBER" as const,
    collectionId: input.collectionId,
    title: input.title,
    body: input.body,
  };
  return {
    projectId: input.projectId as never,
    connectorId: input.connectorId as never,
    connectorEpoch: input.connectorEpoch,
    idempotencyKey: input.idempotencyKey,
    precondition: { kind: "ABSENT" },
    actionDigest: actionDigest(mutation),
    mutation,
  };
}

export function memberEditMutation(
  input: Readonly<{
    projectId: string;
    connectorId: string;
    connectorEpoch: number;
    idempotencyKey: string;
    documentId: string;
    sourceRevision: string;
    comparableDigest: string;
    authoredPatch: AuthoredDocumentPatch;
  }>,
): ExactRevisionMutation<OutlineMutation> {
  const mutation = {
    kind: "EDIT_DOCUMENT_AS_MEMBER" as const,
    documentId: input.documentId,
    authoredPatch: input.authoredPatch,
  };
  return {
    projectId: input.projectId as never,
    connectorId: input.connectorId as never,
    connectorEpoch: input.connectorEpoch,
    idempotencyKey: input.idempotencyKey,
    precondition: {
      kind: "EXACT_REVISION",
      sourceRevision: input.sourceRevision,
      comparableDigest: input.comparableDigest as never,
    },
    actionDigest: actionDigest(mutation),
    mutation,
  };
}
