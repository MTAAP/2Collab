import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type {
  OutlineDocumentProjection,
  OutlineMutation,
  OutlineReadResult,
  OutlineReference,
} from "../../../shared/contracts/outline.ts";
import { prepareAuthoredDocumentPatch } from "../../../shared/contracts/outline.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type {
  ConnectorOperationAuthorization,
  ConnectorScope,
  EphemeralObserved,
  EphemeralSearchPage,
  ExactRevisionMutation,
  Observed,
  ScopedSearch,
} from "../../modules/connectors/contract.ts";
import {
  assertOutlineScope,
  outlineCollectionReferences,
} from "../../modules/connectors/outline-scope.ts";
import type { OutlineContentPort } from "./contract.ts";
import type { OutlineHttpRequest, OutlineHttpTransport } from "./client.ts";

const MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_TOKEN_BYTES = 4_096;

const ProviderUserSchema = z.object({ id: z.string().min(1).max(128) }).passthrough();
const ProviderDocumentSchema = z
  .object({
    id: z.string().min(1).max(128),
    collectionId: z.string().min(1).max(128),
    title: z.string().min(1).max(240),
    text: z.string().max(1_048_576).default(""),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
    archivedAt: z.string().datetime().nullable().optional(),
    updatedBy: ProviderUserSchema.optional(),
  })
  .passthrough();

const DocumentResponseSchema = z.object({ data: ProviderDocumentSchema }).passthrough();
const SearchResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          context: z.string().max(16_384).default(""),
          document: ProviderDocumentSchema,
        })
        .passthrough(),
    ),
    pagination: z.object({ limit: z.number(), offset: z.number() }).passthrough().optional(),
  })
  .passthrough();

function failure(
  code: string,
  message: string,
  retry: "NEVER" | "SAME_INPUT" | "REFRESH" = "NEVER",
): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

function canonicalOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new Error("OUTLINE_BASE_URL_INVALID");
  return url.origin;
}

export function readOutlineTokenFile(path: string): string {
  const token = readFileSync(path, "utf8").trim();
  if (!token || Buffer.byteLength(token, "utf8") > MAXIMUM_TOKEN_BYTES || /\s/u.test(token))
    throw new Error("OUTLINE_TOKEN_FILE_INVALID");
  return token;
}

export function createOutlineFetchTransport(
  input: Readonly<{
    baseUrl: string;
    readToken: () => string;
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
  }>,
): OutlineHttpTransport {
  const origin = canonicalOrigin(input.baseUrl);
  const request = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  return {
    async request(call: OutlineHttpRequest): Promise<unknown> {
      const token = call.accessToken || input.readToken();
      const response = await request(`${origin}/api/${call.endpoint}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(call.body),
      });
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > MAXIMUM_RESPONSE_BYTES) throw new Error("OUTLINE_RESPONSE_TOO_LARGE");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAXIMUM_RESPONSE_BYTES)
        throw new Error("OUTLINE_RESPONSE_TOO_LARGE");
      if (!response.ok) throw new Error(`OUTLINE_HTTP_${response.status}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error("OUTLINE_RESPONSE_INVALID");
      }
    },
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function instant(value: string): number {
  return Math.floor(Date.parse(value) / 1_000);
}

function projection(
  workspaceId: string,
  document: z.infer<typeof ProviderDocumentSchema>,
): OutlineDocumentProjection {
  return {
    workspaceId: workspaceId as never,
    documentId: document.id as never,
    collectionId: document.collectionId as never,
    title: document.title,
    sourceRevision: String(document.revision),
    comparableDigest: digest(document.text) as never,
    sourceUpdatedAt: instant(document.updatedAt),
    archived: !!document.archivedAt,
    ...(document.updatedBy ? { providerActorId: document.updatedBy.id } : {}),
  };
}

export function createProductionOutlineContent(
  input: Readonly<{
    workspaceId: string;
    transport: OutlineHttpTransport;
    clock?: () => number;
    memberAccessToken?: (authorization: ConnectorOperationAuthorization) => Promise<Result<string>>;
  }>,
): OutlineContentPort {
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1_000));
  const call = async (
    endpoint: OutlineHttpRequest["endpoint"],
    body: Record<string, unknown>,
    accessToken = "",
  ) => input.transport.request({ endpoint, accessToken, body });
  const documentWrites = new Map<string, Promise<void>>();
  const withDocumentWriteLock = async <T>(
    documentId: string,
    task: () => Promise<T>,
  ): Promise<T> => {
    const previous = documentWrites.get(documentId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    documentWrites.set(documentId, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (documentWrites.get(documentId) === queued) documentWrites.delete(documentId);
    }
  };

  const readDocument = async (
    documentId: string,
  ): Promise<Result<z.infer<typeof ProviderDocumentSchema>>> => {
    try {
      const parsed = DocumentResponseSchema.safeParse(
        await call("documents.info", { id: documentId }),
      );
      return parsed.success
        ? { ok: true, value: parsed.data.data }
        : failure(
            "OUTLINE_RESPONSE_INVALID",
            "Outline returned an invalid response.",
            "SAME_INPUT",
          );
    } catch {
      return failure("OUTLINE_UNAVAILABLE", "Outline is unavailable.", "SAME_INPUT");
    }
  };

  return {
    async search(
      scope: ConnectorScope,
      query: ScopedSearch,
    ): Promise<Result<EphemeralSearchPage<OutlineReference>>> {
      const collections = [...outlineCollectionReferences(scope)].slice(0, query.providerLimit);
      if (!collections.length)
        return failure(
          "OUTLINE_SCOPE_DENIED",
          "Outline content is outside the current project scope.",
        );
      const results: EphemeralSearchPage<OutlineReference>["results"][number][] = [];
      let bytes = 0;
      let partialFailureCount = 0;
      let providerTruncated = false;
      for (const collectionId of collections) {
        try {
          const parsed = SearchResponseSchema.safeParse(
            await call("documents.search", {
              query: query.query,
              collectionId,
              limit: Math.min(query.resultLimit, 100),
              offset: 0,
              statusFilter: ["published"],
            }),
          );
          if (!parsed.success) {
            partialFailureCount += 1;
            continue;
          }
          providerTruncated ||= parsed.data.data.length >= Math.min(query.resultLimit, 100);
          for (const item of parsed.data.data) {
            if (item.document.collectionId !== collectionId || results.length >= query.resultLimit)
              continue;
            const snippet = item.context.slice(0, 2_048);
            const size = Buffer.byteLength(snippet, "utf8");
            if (bytes + size > query.maximumTotalSnippetBytes) {
              providerTruncated = true;
              continue;
            }
            bytes += size;
            results.push({
              reference: {
                kind: "OUTLINE_DOCUMENT",
                workspaceId: input.workspaceId as never,
                documentId: item.document.id as never,
              },
              title: item.document.title,
              snippet,
              sourceUpdatedAt: instant(item.document.updatedAt),
              persistence: "EPHEMERAL_ONLY",
            });
          }
        } catch {
          partialFailureCount += 1;
        }
      }
      return {
        ok: true,
        value: {
          results,
          partialFailureCount,
          truncated: providerTruncated || results.length >= query.resultLimit,
          persistence: "EPHEMERAL_ONLY",
        },
      };
    },

    async read(
      scope: ConnectorScope,
      reference: OutlineReference,
    ): Promise<Result<EphemeralObserved<OutlineReadResult>>> {
      if (reference.workspaceId !== input.workspaceId)
        return failure(
          "OUTLINE_SCOPE_DENIED",
          "Outline content is outside the current project scope.",
        );
      const loaded = await readDocument(reference.documentId);
      if (!loaded.ok) return loaded;
      const allowed = assertOutlineScope(scope, loaded.value.collectionId);
      if (!allowed.ok) return allowed;
      const safe = projection(input.workspaceId, loaded.value);
      return {
        ok: true,
        value: {
          value: { ...safe, body: loaded.value.text },
          reference: loaded.value.id,
          sourceRevision: safe.sourceRevision,
          observedAt: clock(),
          freshness: "FRESH",
          persistence: "EPHEMERAL_ONLY",
        },
      };
    },

    async mutate(
      authorization: ConnectorOperationAuthorization,
      command: ExactRevisionMutation<OutlineMutation>,
    ): Promise<Result<Observed<OutlineDocumentProjection>>> {
      if (
        authorization.projectId !== command.projectId ||
        authorization.connectorId !== command.connectorId ||
        authorization.connectorEpoch !== command.connectorEpoch ||
        authorization.actionDigest !== command.actionDigest ||
        authorization.expiresAt < clock()
      )
        return failure("CONNECTOR_AUTHORITY_DENIED", "Connector authority is denied.");
      const mutation = command.mutation;
      if (
        mutation.kind === "CREATE_DOCUMENT_AS_MEMBER" &&
        (authorization.reference !== `OUTLINE_COLLECTION:${mutation.collectionId}` ||
          authorization.operation !== "CREATE_DOCUMENT")
      )
        return failure("CONNECTOR_AUTHORITY_DENIED", "Connector authority is denied.");
      if (
        (mutation.kind === "EDIT_DOCUMENT_AS_MEMBER" || mutation.kind === "EDIT_DOCUMENT_AS_BOT") &&
        (authorization.reference !== mutation.documentId ||
          authorization.operation !== "EDIT_CONTENT")
      )
        return failure("CONNECTOR_AUTHORITY_DENIED", "Connector authority is denied.");
      let response: unknown;
      try {
        if (mutation.kind === "CREATE_DOCUMENT_AS_MEMBER") {
          if (command.precondition.kind !== "ABSENT")
            return failure("SOURCE_REVISION_STALE", "Source revision is stale.", "REFRESH");
          if (!input.memberAccessToken)
            return failure(
              "OUTLINE_MEMBER_GRANT_REQUIRED",
              "A delegated member grant is required.",
            );
          const access = await input.memberAccessToken(authorization);
          if (!access.ok) return access;
          response = await call(
            "documents.create",
            {
              collectionId: mutation.collectionId,
              title: mutation.title,
              text: mutation.body,
              publish: true,
            },
            access.value,
          );
        } else if (
          mutation.kind === "EDIT_DOCUMENT_AS_MEMBER" ||
          mutation.kind === "EDIT_DOCUMENT_AS_BOT"
        ) {
          const edited = await withDocumentWriteLock(mutation.documentId, async () => {
            const current = await readDocument(mutation.documentId);
            if (!current.ok) return current;
            if (
              command.precondition.kind !== "EXACT_REVISION" ||
              command.precondition.sourceRevision !== String(current.value.revision) ||
              command.precondition.comparableDigest !== digest(current.value.text)
            )
              return failure("SOURCE_REVISION_STALE", "Source revision is stale.", "REFRESH");
            const patched = prepareAuthoredDocumentPatch(
              current.value.text,
              mutation.authoredPatch.value,
            );
            if (!patched.ok) return patched;
            let accessToken = "";
            if (mutation.kind === "EDIT_DOCUMENT_AS_MEMBER") {
              if (!input.memberAccessToken)
                return failure(
                  "OUTLINE_MEMBER_GRANT_REQUIRED",
                  "A delegated member grant is required.",
                );
              const access = await input.memberAccessToken(authorization);
              if (!access.ok) return access;
              accessToken = access.value;
            }
            let updated: unknown;
            try {
              updated = await call(
                "documents.update",
                {
                  id: mutation.documentId,
                  text: patched.value.text,
                  editMode: patched.value.editMode,
                  ...(patched.value.findText ? { findText: patched.value.findText } : {}),
                },
                accessToken,
              );
            } catch (error) {
              return error instanceof Error && error.message === "OUTLINE_HTTP_400"
                ? failure("SOURCE_REVISION_STALE", "Source revision is stale.", "REFRESH")
                : failure(
                    "OUTLINE_RESULT_UNKNOWN",
                    "Outline mutation result is unknown.",
                    "REFRESH",
                  );
            }
            const parsed = DocumentResponseSchema.safeParse(updated);
            if (
              !parsed.success ||
              parsed.data.data.revision <= current.value.revision ||
              parsed.data.data.text !== patched.value.body
            )
              return failure(
                "OUTLINE_RESULT_UNKNOWN",
                "Outline mutation result is unknown.",
                "REFRESH",
              );
            const confirmed = await readDocument(mutation.documentId);
            if (
              !confirmed.ok ||
              confirmed.value.revision !== parsed.data.data.revision ||
              confirmed.value.text !== parsed.data.data.text
            )
              return failure(
                "OUTLINE_RESULT_UNKNOWN",
                "Outline mutation result is unknown.",
                "REFRESH",
              );
            return { ok: true as const, value: parsed.data };
          });
          if (!edited.ok) return edited;
          response = edited.value;
        } else if (mutation.kind === "PROMOTE_WORKING_DOCUMENT") {
          response = await call("documents.update", {
            id: mutation.workingDocumentId,
            collectionId: mutation.targetCollectionId,
            title: mutation.title,
            publish: true,
          });
        } else if (mutation.kind === "ARCHIVE_WORKING_DOCUMENT") {
          response = await call("documents.archive", { id: mutation.workingDocumentId });
        } else {
          return failure("OUTLINE_MUTATION_UNSUPPORTED", "Outline mutation is unsupported.");
        }
      } catch {
        return failure("OUTLINE_RESULT_UNKNOWN", "Outline mutation result is unknown.", "REFRESH");
      }
      const parsed = DocumentResponseSchema.safeParse(response);
      if (!parsed.success)
        return failure("OUTLINE_RESULT_UNKNOWN", "Outline mutation result is unknown.", "REFRESH");
      const value = projection(input.workspaceId, parsed.data.data);
      return {
        ok: true,
        value: {
          value,
          reference: parsed.data.data.id,
          sourceRevision: value.sourceRevision,
          comparableDigest: value.comparableDigest as never,
          projectionRevision: parsed.data.data.revision,
          observedAt: clock(),
          sourceUpdatedAt: value.sourceUpdatedAt,
          freshness: "FRESH",
          consistency: "RESIDUAL_RACE",
          provenance: {
            projectId: command.projectId,
            connectorId: command.connectorId,
            connectorEpoch: command.connectorEpoch,
            kind: "MUTATION_CONFIRMATION",
            ...(value.providerActorId ? { providerActorId: value.providerActorId } : {}),
          },
        },
      };
    },
  };
}
