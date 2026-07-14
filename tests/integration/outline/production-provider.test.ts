import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createOutlineFetchTransport,
  createProductionOutlineContent,
} from "../../../src/server/adapters/outline/production-content.ts";

test("fetch transport uses a delegated token when supplied and otherwise uses the bot token", async () => {
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
    accessToken: "delegated-member-token",
    body: { query: "bounded" },
  });
  await transport.request({
    endpoint: "documents.search",
    accessToken: "",
    body: { query: "bot" },
  });

  expect(calls).toEqual([
    {
      url: "https://wiki.example.test/api/documents.search",
      authorization: "Bearer delegated-member-token",
      body: { query: "bounded" },
    },
    {
      url: "https://wiki.example.test/api/documents.search",
      authorization: "Bearer secret-token",
      body: { query: "bot" },
    },
  ]);
});

function authorization() {
  return {
    kind: "CONNECTOR_OPERATION" as const,
    id: "authorization_1",
    proof: "p".repeat(32),
    projectId: "project_1" as never,
    connectorId: "outline_1" as never,
    connectorEpoch: 1,
    reference: "doc_1",
    operation: "EDIT_CONTENT",
    actionDigest: "a".repeat(64) as never,
    expiresAt: 100,
  };
}

function editCommand(body: string, revision: number, patch: string) {
  return {
    projectId: "project_1" as never,
    connectorId: "outline_1" as never,
    connectorEpoch: 1,
    idempotencyKey: "edit_1",
    precondition: {
      kind: "EXACT_REVISION" as const,
      sourceRevision: String(revision),
      comparableDigest: createHash("sha256").update(body).digest("hex") as never,
    },
    actionDigest: "a".repeat(64) as never,
    mutation: {
      kind: "EDIT_DOCUMENT_AS_MEMBER" as const,
      documentId: "doc_1" as never,
      authoredPatch: {
        format: "UNIFIED_TEXT_PATCH_V1" as const,
        value: patch,
        digest: createHash("sha256").update(patch).digest("hex") as never,
      },
    },
  };
}

test("production Outline edits honor hunk offsets, insertions, and multiple hunks", async () => {
  let providerText = "alpha\nITEM\nmiddle\nITEM\nomega";
  let revision = 1;
  const updates: Readonly<Record<string, unknown>>[] = [];
  const content = createProductionOutlineContent({
    workspaceId: "workspace_1",
    clock: () => 10,
    memberAccessToken: async () => ({ ok: true, value: "delegated-token" }),
    transport: {
      async request(input) {
        if (input.endpoint === "documents.info")
          return {
            data: {
              id: "doc_1",
              collectionId: "allowed",
              title: "Document",
              text: providerText,
              revision,
              updatedAt: "2026-07-12T10:00:00.000Z",
              archivedAt: null,
            },
          };
        if (input.endpoint === "documents.update") {
          updates.push(input.body);
          const findText = String(input.body.findText);
          if (!providerText.includes(findText)) throw new Error("OUTLINE_HTTP_400");
          providerText = providerText.replace(findText, String(input.body.text));
          revision += 1;
          return {
            data: {
              id: "doc_1",
              collectionId: "allowed",
              title: "Document",
              text: providerText,
              revision,
              updatedAt: "2026-07-12T10:00:01.000Z",
              archivedAt: null,
              updatedBy: { id: "member_1" },
            },
          };
        }
        throw new Error("UNEXPECTED_ENDPOINT");
      },
    },
  });
  const patch = "@@ -2,1 +2,1 @@\n ITEM\n@@ -4,1 +4,2 @@\n-ITEM\n+DONE\n+inserted";
  const result = await content.mutate(authorization(), editCommand(providerText, revision, patch));

  expect(result).toMatchObject({ ok: true, value: { consistency: "RESIDUAL_RACE" } });
  expect(providerText).toBe("alpha\nITEM\nmiddle\nDONE\ninserted\nomega");
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ editMode: "patch" });
});

test("production Outline native patch rejects a raced edit instead of overwriting it", async () => {
  const original = "before\nITEM\nafter";
  let providerText = original;
  let revision = 1;
  const content = createProductionOutlineContent({
    workspaceId: "workspace_1",
    clock: () => 10,
    memberAccessToken: async () => ({ ok: true, value: "delegated-token" }),
    transport: {
      async request(input) {
        if (input.endpoint === "documents.info")
          return {
            data: {
              id: "doc_1",
              collectionId: "allowed",
              title: "Document",
              text: providerText,
              revision,
              updatedAt: "2026-07-12T10:00:00.000Z",
              archivedAt: null,
            },
          };
        if (input.endpoint === "documents.update") {
          providerText = "before\nhuman edit\nafter";
          revision += 1;
          const findText = String(input.body.findText);
          if (!providerText.includes(findText)) throw new Error("OUTLINE_HTTP_400");
          providerText = providerText.replace(findText, String(input.body.text));
          throw new Error("UNREACHABLE");
        }
        throw new Error("UNEXPECTED_ENDPOINT");
      },
    },
  });
  const result = await content.mutate(
    authorization(),
    editCommand(original, 1, "@@ -2,1 +2,1 @@\n-ITEM\n+agent edit"),
  );

  expect(result).toMatchObject({ ok: false, error: { code: "SOURCE_REVISION_STALE" } });
  expect(providerText).toBe("before\nhuman edit\nafter");
});

test("production Outline rejects a delegated edit authorization for another document", async () => {
  let calls = 0;
  const content = createProductionOutlineContent({
    workspaceId: "workspace_1",
    memberAccessToken: async () => ({ ok: true, value: "delegated-token" }),
    transport: {
      async request() {
        calls += 1;
        throw new Error("UNEXPECTED_PROVIDER_CALL");
      },
    },
  });
  const mismatched = { ...authorization(), reference: "doc_2" };
  const result = await content.mutate(
    mismatched,
    editCommand("ITEM", 1, "@@ -1,1 +1,1 @@\n-ITEM\n+DONE"),
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "CONNECTOR_AUTHORITY_DENIED" },
  });
  expect(calls).toBe(0);
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
