import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createOutlineFetchTransport,
  createProductionOutlineContent,
  readOutlineTokenFile,
} from "../src/server/adapters/outline/production-content.ts";

const baseUrl = Bun.env.OUTLINE_BASE_URL;
const tokenFile = Bun.env.OUTLINE_TOKEN_FILE;
if (!baseUrl || !tokenFile) throw new Error("OUTLINE_LIVE_CONFIGURATION_REQUIRED");

const transport = createOutlineFetchTransport({
  baseUrl,
  readToken: () => readOutlineTokenFile(tokenFile),
});
const request = (endpoint: Parameters<typeof transport.request>[0]["endpoint"], body = {}) =>
  transport.request({ endpoint, accessToken: "", body });

const AuthSchema = z
  .object({
    data: z.object({
      user: z.object({ id: z.string().min(1) }).passthrough(),
      team: z.object({ id: z.string().min(1) }).passthrough(),
    }),
  })
  .passthrough();
const CollectionsSchema = z
  .object({
    data: z.array(z.object({ id: z.string().min(1) }).passthrough()).min(1),
  })
  .passthrough();
const DocumentSchema = z
  .object({
    data: z
      .object({
        id: z.string().min(1),
        revision: z.number().int().nonnegative(),
        text: z.string().default(""),
        archivedAt: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const SearchSchema = z
  .object({
    data: z.array(
      z.object({ document: z.object({ id: z.string().min(1) }).passthrough() }).passthrough(),
    ),
  })
  .passthrough();

const auth = AuthSchema.parse(await request("auth.info"));
const collections = CollectionsSchema.parse(
  await request("collections.list", { limit: 100, offset: 0 }),
);
const collectionId = Bun.env.OUTLINE_COLLECTION_ID ?? collections.data[0]?.id;
if (!collectionId) throw new Error("OUTLINE_LIVE_COLLECTION_REQUIRED");
const marker = `2collab-live-${randomUUID()}`;
const initialText = `Disposable 2Collab provider smoke ${marker}`;
let documentId: string | undefined;
let evidence: Readonly<Record<string, unknown>> | undefined;
let cleanupConfirmed = false;

try {
  const created = DocumentSchema.parse(
    await request("documents.create", {
      collectionId,
      title: marker,
      text: initialText,
      publish: true,
    }),
  );
  documentId = created.data.id;
  const searched = SearchSchema.parse(
    await request("documents.search", {
      query: marker,
      collectionId,
      limit: 10,
      offset: 0,
      statusFilter: ["published"],
    }),
  );
  if (!searched.data.some((result) => result.document.id === documentId))
    throw new Error("OUTLINE_LIVE_SEARCH_MISMATCH");
  const read = DocumentSchema.parse(await request("documents.info", { id: documentId }));
  if (read.data.text !== initialText) throw new Error("OUTLINE_LIVE_READ_MISMATCH");
  const updatedText = `${initialText}\n\nUpdated through the production Outline transport.`;
  const updated = DocumentSchema.parse(
    await request("documents.update", { id: documentId, text: updatedText }),
  );
  if (updated.data.revision <= created.data.revision)
    throw new Error("OUTLINE_LIVE_REVISION_DID_NOT_ADVANCE");
  const confirmed = DocumentSchema.parse(await request("documents.info", { id: documentId }));
  if (confirmed.data.text !== updatedText || confirmed.data.revision !== updated.data.revision)
    throw new Error("OUTLINE_LIVE_UPDATE_MISMATCH");
  const content = createProductionOutlineContent({
    workspaceId: auth.data.team.id,
    transport,
  });
  const patch = `@@ -1,1 +1,1 @@\n-${initialText}\n+stale replacement`;
  const patchDigest = createHash("sha256").update(patch).digest("hex");
  const actionDigest = createHash("sha256").update(marker).digest("hex");
  const stale = await content.mutate(
    {
      kind: "CONNECTOR_OPERATION",
      id: marker,
      proof: marker,
      projectId: "live_project" as never,
      connectorId: "live_outline" as never,
      connectorEpoch: 1,
      reference: documentId,
      operation: "EDIT_CONTENT",
      actionDigest: actionDigest as never,
      expiresAt: Math.floor(Date.now() / 1_000) + 30,
    },
    {
      projectId: "live_project" as never,
      connectorId: "live_outline" as never,
      connectorEpoch: 1,
      idempotencyKey: marker,
      precondition: {
        kind: "EXACT_REVISION",
        sourceRevision: String(created.data.revision),
        comparableDigest: createHash("sha256").update(initialText).digest("hex") as never,
      },
      actionDigest: actionDigest as never,
      mutation: {
        kind: "EDIT_DOCUMENT_AS_MEMBER",
        documentId,
        authoredPatch: {
          format: "UNIFIED_TEXT_PATCH_V1",
          value: patch,
          digest: patchDigest as never,
        },
      },
    },
  );
  if (stale.ok || stale.error.code !== "SOURCE_REVISION_STALE")
    throw new Error("OUTLINE_LIVE_CONFLICT_NOT_REJECTED");
  evidence = {
    ok: true,
    workspaceId: auth.data.team.id,
    providerUserId: auth.data.user.id,
    collectionId,
    documentId,
    createdRevision: created.data.revision,
    updatedRevision: updated.data.revision,
    searchConfirmed: true,
    readConfirmed: true,
    updateConfirmed: true,
    conflictConfirmed: true,
  };
} finally {
  if (documentId) {
    const archived = DocumentSchema.parse(await request("documents.archive", { id: documentId }));
    cleanupConfirmed = !!archived.data.archivedAt;
  }
}
if (!cleanupConfirmed) throw new Error("OUTLINE_LIVE_CLEANUP_FAILED");
console.log(JSON.stringify({ ...evidence, cleanupConfirmed }));
