import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  createHumanDocumentEditing,
  type OutlineMemberMutationAuthorityPort,
} from "../../../src/server/modules/documents/human-editing.ts";
import { StrictOutlineContentAdapter } from "../../fixtures/outline/strict-outline-adapter.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const scope = {
  projectId: "project_1" as never,
  connectorId: "connector_1" as never,
  connectorEpoch: 1,
  references: ["OUTLINE_COLLECTION:allowed"],
  operations: ["CREATE_DOCUMENT", "EDIT_CONTENT"],
};
const authority: OutlineMemberMutationAuthorityPort = {
  async currentScope() {
    return { ok: true, value: scope };
  },
  async authorize(input) {
    return {
      ok: true,
      value: {
        kind: "CONNECTOR_OPERATION",
        id: input.memberId,
        proof: "proof",
        projectId: input.command.projectId,
        connectorId: input.command.connectorId,
        connectorEpoch: input.command.connectorEpoch,
        reference: input.reference,
        operation: input.operation,
        actionDigest: input.command.actionDigest,
        expiresAt: Date.now() + 1_000,
      },
    };
  },
  async confirm(observed) {
    return { ok: true, value: observed };
  },
  async fail() {},
};

test("creates with the delegated member identity and an absent precondition", async () => {
  const outline = StrictOutlineContentAdapter.seed();
  const editing = createHumanDocumentEditing({
    outline,
    authority,
    async requireDelegatedMember(memberId) {
      return { ok: true, value: { outlineUserId: memberId } };
    },
  });
  const result = await editing.createDocumentAsMember({
    memberId: "member_a",
    projectId: "project_1",
    connectorId: "connector_1",
    connectorEpoch: 1,
    workspaceId: "workspace_1",
    idempotencyKey: "create_1",
    collectionId: "allowed",
    title: "Shared",
    body: "first",
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.value.providerActorId).toBe("OUTLINE_MEMBER:member_a");
});

export { authority, hash, scope };
