import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createOutlineFetchTransport,
  createProductionOutlineContent,
} from "../../../src/server/adapters/outline/production-content.ts";

test("fetch transport sends a bearer token only to the configured Outline origin", async () => {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const transport = createOutlineFetchTransport({
    baseUrl: "https://wiki.example.test/",
    readToken: () => "secret-token",
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ data: [] });
    },
  });

  await transport.request({
    endpoint: "documents.search",
    accessToken: "ignored-by-production-transport",
    body: { query: "bounded" },
  });

  expect(calls).toEqual([
    {
      url: "https://wiki.example.test/api/documents.search",
      authorization: "Bearer secret-token",
      body: { query: "bounded" },
    },
  ]);
});

test("production Outline content scopes search and read to granted collections", async () => {
  const requests: Array<{ endpoint: string; body: Readonly<Record<string, unknown>> }> = [];
  const content = createProductionOutlineContent({
    workspaceId: "workspace_1",
    clock: () => 1_700_000_000,
    transport: {
      async request(input) {
        requests.push({ endpoint: input.endpoint, body: input.body });
        if (input.endpoint === "documents.search")
          return {
            data: [
              {
                context: "matching bounded snippet",
                document: {
                  id: "doc_1",
                  collectionId: "allowed",
                  title: "Live document",
                  text: "body",
                  revision: 4,
                  updatedAt: "2026-07-12T10:00:00.000Z",
                  archivedAt: null,
                },
              },
            ],
            pagination: { limit: 10, offset: 0 },
          };
        return {
          data: {
            id: "doc_1",
            collectionId: "allowed",
            title: "Live document",
            text: "body",
            revision: 4,
            updatedAt: "2026-07-12T10:00:00.000Z",
            archivedAt: null,
            updatedBy: { id: "outline_user_1" },
          },
        };
      },
    },
  });
  const scope = {
    projectId: "project_1" as never,
    connectorId: "outline_1" as never,
    connectorEpoch: 1,
    references: ["OUTLINE_COLLECTION:allowed"],
    operations: ["SEARCH", "READ"],
  };

  const search = await content.search(scope, {
    query: "bounded",
    providerLimit: 10,
    resultLimit: 5,
    maximumTotalSnippetBytes: 1_024,
    timeoutMs: 2_000,
  });
  expect(search.ok).toBeTrue();
  if (search.ok) expect(search.value.results[0]?.reference.documentId).toBe("doc_1");
  expect(requests[0]?.body).toMatchObject({ collectionId: "allowed", limit: 5 });

  const read = await content.read(scope, {
    kind: "OUTLINE_DOCUMENT",
    workspaceId: "workspace_1" as never,
    documentId: "doc_1" as never,
  });
  expect(read.ok).toBeTrue();
  if (read.ok) {
    expect(read.value.value.comparableDigest).toBe(
      createHash("sha256").update("body").digest("hex"),
    );
    expect(read.value.persistence).toBe("EPHEMERAL_ONLY");
  }
});

test("production Outline content fails closed for another workspace or collection", async () => {
  const content = createProductionOutlineContent({
    workspaceId: "workspace_1",
    clock: () => 1,
    transport: {
      request: async () => ({
        data: {
          id: "doc_1",
          collectionId: "denied",
          title: "Denied",
          text: "secret",
          revision: 1,
          updatedAt: "2026-07-12T10:00:00.000Z",
          archivedAt: null,
        },
      }),
    },
  });
  const scope = {
    projectId: "project_1" as never,
    connectorId: "outline_1" as never,
    connectorEpoch: 1,
    references: ["OUTLINE_COLLECTION:allowed"],
    operations: ["READ"],
  };
  const wrongWorkspace = await content.read(scope, {
    kind: "OUTLINE_DOCUMENT",
    workspaceId: "workspace_2" as never,
    documentId: "doc_1" as never,
  });
  const wrongCollection = await content.read(scope, {
    kind: "OUTLINE_DOCUMENT",
    workspaceId: "workspace_1" as never,
    documentId: "doc_1" as never,
  });
  expect(wrongWorkspace.ok).toBeFalse();
  expect(wrongCollection.ok).toBeFalse();
});
