import { createHash } from "node:crypto";
import type {
  EncryptedOutlineOAuthGrant,
  EphemeralProviderAccess,
  OutlineDocumentProjection,
  OutlineProviderIdentity,
  OutlineReadResult,
  OutlineReference,
  ProviderTokenSet,
  VerifiedOutlineOAuthMetadata,
  VerifiedOutlineOAuthTransaction,
} from "../../../src/shared/contracts/outline.ts";
import type { Result } from "../../../src/shared/contracts/result.ts";
import type { OutlineContentPort } from "../../../src/server/adapters/outline/contract.ts";
import type { OutlineOAuthProviderPort } from "../../../src/server/adapters/outline/oauth-provider-contract.ts";
import { assertOutlineScope } from "../../../src/server/adapters/outline/scope.ts";
import type {
  ConnectorOperationAuthorization,
  ConnectorScope,
  EphemeralObserved,
  EphemeralSearchPage,
  ExactRevisionMutation,
  Observed,
  ScopedSearch,
} from "../../../src/server/modules/connectors/contract.ts";
import type { OutlineMutation } from "../../../src/shared/contracts/outline.ts";

type FixtureDocument = {
  id: string;
  collectionId: string;
  title: string;
  body: string;
  revision: number;
  actor: string;
  updatedAt: number;
  archived: boolean;
};
export type OutlineFixtureFault = "UNAVAILABLE" | "LOST_RESPONSE";
export type OutlineCall = Readonly<{
  operation: "SEARCH" | "READ" | "MUTATE";
  actor?: string;
  documentId?: string;
}>;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const failure = (
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" | "SAME_INPUT" = "NEVER",
): Result<never> => ({ ok: false, error: { code, message, retry } });

export class StrictOutlineContentAdapter implements OutlineContentPort {
  readonly calls: OutlineCall[] = [];
  private readonly documents = new Map<string, FixtureDocument>();
  private nextFault: OutlineFixtureFault | undefined;
  private nextId = 1;

  static seed(
    input: Readonly<{
      documents?: readonly (Partial<FixtureDocument> &
        Pick<FixtureDocument, "id" | "collectionId" | "title" | "body">)[];
    }> = {},
  ) {
    const adapter = new StrictOutlineContentAdapter();
    for (const document of input.documents ?? []) adapter.seedDocument(document);
    return adapter;
  }

  seedDocument(
    input: Partial<FixtureDocument> &
      Pick<FixtureDocument, "id" | "collectionId" | "title" | "body">,
  ): void {
    this.documents.set(input.id, {
      ...input,
      revision: input.revision ?? 1,
      actor: input.actor ?? "OUTLINE_MEMBER:seed",
      updatedAt: input.updatedAt ?? 0,
      archived: input.archived ?? false,
    });
  }
  changeExternally(documentId: string, body: string): void {
    const current = this.documents.get(documentId);
    if (!current) throw new Error("DOCUMENT_NOT_FOUND");
    current.body = body;
    current.revision += 1;
    current.actor = "OUTLINE_MEMBER:external";
  }
  moveExternally(documentId: string, collectionId: string): void {
    const current = this.documents.get(documentId);
    if (!current) throw new Error("DOCUMENT_NOT_FOUND");
    current.collectionId = collectionId;
    current.revision += 1;
  }
  failNext(fault: OutlineFixtureFault): void {
    this.nextFault = fault;
  }
  body(documentId: string): string | undefined {
    return this.documents.get(documentId)?.body;
  }

  async search(
    scope: ConnectorScope,
    query: ScopedSearch,
  ): Promise<Result<EphemeralSearchPage<OutlineReference>>> {
    this.calls.push({ operation: "SEARCH" });
    if (this.consumeFault() === "UNAVAILABLE")
      return failure("OUTLINE_UNAVAILABLE", "Outline is unavailable.", "SAME_INPUT");
    let bytes = 0;
    const results = [...this.documents.values()]
      .filter(
        (document) => !document.archived && assertOutlineScope(scope, document.collectionId).ok,
      )
      .filter((document) =>
        `${document.title}\n${document.body}`.toLowerCase().includes(query.query.toLowerCase()),
      )
      .slice(0, Math.min(query.resultLimit, query.providerLimit))
      .flatMap((document) => {
        const snippet = document.body.slice(0, 256);
        const size = Buffer.byteLength(snippet);
        if (bytes + size > query.maximumTotalSnippetBytes) return [];
        bytes += size;
        return [
          {
            reference: {
              kind: "OUTLINE_DOCUMENT" as const,
              workspaceId: "workspace_1" as never,
              documentId: document.id as never,
            },
            title: document.title,
            snippet,
            sourceUpdatedAt: document.updatedAt,
            persistence: "EPHEMERAL_ONLY" as const,
          },
        ];
      });
    return {
      ok: true,
      value: {
        results,
        partialFailureCount: 0,
        truncated: results.length >= query.resultLimit,
        persistence: "EPHEMERAL_ONLY",
      },
    };
  }

  async read(
    scope: ConnectorScope,
    reference: OutlineReference,
  ): Promise<Result<EphemeralObserved<OutlineReadResult>>> {
    this.calls.push({ operation: "READ", documentId: reference.documentId });
    const document = this.documents.get(reference.documentId);
    if (!document || !assertOutlineScope(scope, document.collectionId).ok)
      return failure(
        "OUTLINE_SCOPE_DENIED",
        "Outline content is outside the current project scope.",
      );
    return {
      ok: true,
      value: {
        value: this.live(document),
        reference: document.id,
        sourceRevision: String(document.revision),
        observedAt: document.updatedAt,
        freshness: "FRESH",
        persistence: "EPHEMERAL_ONLY",
      },
    };
  }

  async mutate(
    authorization: ConnectorOperationAuthorization,
    command: ExactRevisionMutation<OutlineMutation>,
  ): Promise<Result<Observed<OutlineDocumentProjection>>> {
    const mutation = command.mutation;
    const actor =
      mutation.kind === "EDIT_DOCUMENT_AS_BOT"
        ? `OUTLINE_BOT:${mutation.provenance.runId}`
        : `OUTLINE_MEMBER:${authorization.id}`;
    const documentId = "documentId" in mutation ? mutation.documentId : `doc_${this.nextId++}`;
    this.calls.push({ operation: "MUTATE", actor, documentId });
    if (
      authorization.actionDigest !== command.actionDigest ||
      authorization.connectorEpoch !== command.connectorEpoch
    )
      return failure("CONNECTOR_AUTHORITY_DENIED", "Connector authority is denied.");
    let document = this.documents.get(documentId);
    if (mutation.kind === "CREATE_DOCUMENT_AS_MEMBER") {
      if (command.precondition.kind !== "ABSENT")
        return failure("SOURCE_REVISION_STALE", "Source revision is stale.", "REFRESH");
      document = {
        id: documentId,
        collectionId: mutation.collectionId,
        title: mutation.title,
        body: mutation.body,
        revision: 1,
        actor,
        updatedAt: Date.now(),
        archived: false,
      };
      this.documents.set(documentId, document);
    } else if (
      mutation.kind === "EDIT_DOCUMENT_AS_MEMBER" ||
      mutation.kind === "EDIT_DOCUMENT_AS_BOT"
    ) {
      if (!document)
        return failure("CONTEXT_REFERENCE_UNAVAILABLE", "Context reference is unavailable.");
      if (
        command.precondition.kind !== "EXACT_REVISION" ||
        command.precondition.sourceRevision !== String(document.revision) ||
        command.precondition.comparableDigest !== hash(document.body)
      ) {
        return {
          ok: false,
          error: {
            code: "SOURCE_REVISION_STALE",
            message: "Source revision is stale.",
            retry: "REFRESH",
            details: {
              currentRevision: String(document.revision),
              authoredPatchDigest: mutation.authoredPatch.digest,
            },
          },
        };
      }
      document.body = applyPatch(document.body, mutation.authoredPatch.value);
      document.revision += 1;
      document.actor = actor;
    } else return failure("OUTLINE_MUTATION_UNSUPPORTED", "Outline mutation is unsupported.");
    const fault = this.consumeFault();
    if (fault === "LOST_RESPONSE")
      return failure("OUTLINE_RESULT_UNKNOWN", "Outline mutation result is unknown.", "REFRESH");
    return { ok: true, value: this.observed(command, document) };
  }

  private live(document: FixtureDocument): OutlineReadResult {
    return { ...this.projection(document), body: document.body };
  }
  private projection(document: FixtureDocument): OutlineDocumentProjection {
    return {
      workspaceId: "workspace_1" as never,
      documentId: document.id as never,
      collectionId: document.collectionId as never,
      title: document.title,
      sourceRevision: String(document.revision),
      comparableDigest: hash(document.body) as never,
      sourceUpdatedAt: document.updatedAt,
      archived: document.archived,
      providerActorId: document.actor,
    };
  }
  private observed(
    command: ExactRevisionMutation<OutlineMutation>,
    document: FixtureDocument,
  ): Observed<OutlineDocumentProjection> {
    return {
      value: this.projection(document),
      reference: document.id,
      sourceRevision: String(document.revision),
      comparableDigest: hash(document.body) as never,
      projectionRevision: document.revision,
      observedAt: document.updatedAt,
      freshness: "FRESH",
      provenance: {
        projectId: command.projectId,
        connectorId: command.connectorId,
        connectorEpoch: command.connectorEpoch,
        kind: "MUTATION_CONFIRMATION",
        providerActorId: document.actor,
      },
    };
  }
  private consumeFault(): OutlineFixtureFault | undefined {
    const value = this.nextFault;
    this.nextFault = undefined;
    return value;
  }
}

function applyPatch(body: string, patch: string): string {
  const removed = patch
    .split("\n")
    .filter((line) => line.startsWith("-"))
    .map((line) => line.slice(1))
    .join("\n");
  const added = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  return removed.length > 0 && body.includes(removed) ? body.replace(removed, added) : added;
}

export class StrictOutlineOAuthProvider implements OutlineOAuthProviderPort {
  private revoked = false;
  private identity: OutlineProviderIdentity = {
    workspaceId: "workspace_1" as never,
    userId: "member_1" as never,
    displayName: "Member One",
  };
  setIdentity(identity: OutlineProviderIdentity): void {
    this.identity = identity;
  }
  async discover(origin: string): Promise<Result<VerifiedOutlineOAuthMetadata>> {
    return {
      ok: true,
      value: {
        origin,
        authorizationEndpoint: `${origin}/oauth/authorize`,
        tokenEndpoint: `${origin}/oauth/token`,
        revocationEndpoint: `${origin}/oauth/revoke`,
        supportsPkceS256: true,
        digest: hash(origin),
      },
    };
  }
  async exchange(
    _transaction: VerifiedOutlineOAuthTransaction,
    authorizationCode: string,
  ): Promise<Result<ProviderTokenSet>> {
    return this.revoked
      ? failure("OUTLINE_OAUTH_REVOKED", "Outline OAuth is revoked.")
      : {
          ok: true,
          value: {
            accessToken: `access:${authorizationCode}`,
            refreshToken: "refresh:fixture",
            expiresAt: Date.now() + 3600_000,
            grantedScope: ["read", "write"],
          },
        };
  }
  async refresh(_grant: EncryptedOutlineOAuthGrant): Promise<Result<ProviderTokenSet>> {
    return {
      ok: true,
      value: {
        accessToken: "access:rotated",
        refreshToken: "refresh:rotated",
        expiresAt: Date.now() + 3600_000,
        grantedScope: ["read", "write"],
      },
    };
  }
  async revoke(_grant: EncryptedOutlineOAuthGrant): Promise<Result<{ revoked: boolean }>> {
    this.revoked = true;
    return { ok: true, value: { revoked: true } };
  }
  async inspectIdentity(
    _access: EphemeralProviderAccess,
  ): Promise<Result<OutlineProviderIdentity>> {
    return { ok: true, value: this.identity };
  }
}
