import { expect, test } from "bun:test";
import { createOutlineReferenceProvider } from "../../../src/server/modules/context/outline-reference-provider.ts";
import { StrictOutlineContentAdapter } from "../../fixtures/outline/strict-outline-adapter.ts";

test("denied reads persist neither a guessed identifier nor provider body", async () => {
  const records: unknown[] = [];
  const provider = createOutlineReferenceProvider({
    outline: StrictOutlineContentAdapter.seed({
      documents: [
        {
          id: "guessed-secret-id",
          collectionId: "denied",
          title: "Secret",
          body: "forbidden-body",
        },
      ],
    }),
    projections: {
      async upsert() {
        throw new Error("projection must not persist");
      },
    },
    provenance: {
      async record(value) {
        records.push(value);
      },
    },
  });
  const result = await provider.get({
    actor: { kind: "RUN_ATTEMPT", runId: "run_1", attemptId: "attempt_1" },
    scope: {
      projectId: "project_1" as never,
      connectorId: "connector_1" as never,
      connectorEpoch: 1,
      references: ["OUTLINE_COLLECTION:allowed"],
      operations: ["READ"],
    },
    reference: {
      kind: "OUTLINE_DOCUMENT",
      workspaceId: "workspace_1" as never,
      documentId: "guessed-secret-id" as never,
    },
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(records)).not.toContain("guessed-secret-id");
  expect(JSON.stringify(records)).not.toContain("forbidden-body");
});
