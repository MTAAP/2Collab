import type { Database } from "bun:sqlite";
import type { MemberActor } from "../shared/contracts/actors.ts";
import {
  GitHubProjectionSchema,
  type GitHubWorkItemReference,
} from "../shared/contracts/github.ts";
import type { OutlineMutation, OutlineReference } from "../shared/contracts/outline.ts";
import type { Result } from "../shared/contracts/result.ts";
import type { ServerEnvironment } from "../shared/environment.ts";
import {
  GitHubInstallationTokenCache,
  GITHUB_REST_HEADERS,
  createGitHubAppJwt,
  requestInstallationToken,
} from "./adapters/github/app-auth.ts";
import { createGitHubRestProvider } from "./adapters/github/rest-provider.ts";
import {
  consumeVerifiedGitHubWebhook,
  recordVerifiedGitHubDelivery,
} from "./adapters/github/webhooks.ts";
import type { PublicAuthenticationPort } from "./adapters/http/middleware/authentication.ts";
import type { PublicRateLimitPort } from "./adapters/http/middleware/request-limits.ts";
import {
  createOutlineFetchTransport,
  createProductionOutlineContent,
  readOutlineTokenFile,
} from "./adapters/outline/production-content.ts";
import type { OutlineContentPort } from "./adapters/outline/contract.ts";
import type { ServerResources } from "./dependencies.ts";
import { createGitHubProductionComposition } from "./github-production-composition.ts";
import type { createConnectorAuthority } from "./modules/connectors/connector-authority.ts";
import type {
  ConnectorOperationAuthorization,
  ConnectorScope,
  ExactRevisionMutation,
  ReconciliationCursor,
} from "./modules/connectors/contract.ts";
import { reconcileGitHubScope } from "./adapters/github/reconciliation.ts";
import { commandCenterCard } from "./modules/inbox/command-center.ts";
import type { InboxItem } from "./modules/inbox/inbox.ts";
import type { GitHubPort } from "./modules/github-coordination/contract.ts";
import type { PublicRunOperations } from "./modules/public-surface/contract.ts";
import type { CredentialKeyManager } from "./operations/key-rotation.ts";

type ConnectorAuthority = ReturnType<typeof createConnectorAuthority>;

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  environment: ServerEnvironment;
  credentials: CredentialKeyManager;
  connectorAuthority: ConnectorAuthority;
  authentication: PublicAuthenticationPort;
  rateLimits: PublicRateLimitPort;
  runs: PublicRunOperations;
}>;

function failure(
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" | "SAME_INPUT" = "NEVER",
): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

function digest(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}

function authorizeProject(
  database: Database,
  _actor: MemberActor,
  projectId: string,
): Promise<Result<Readonly<{ authorized: true }>>> {
  const project = database
    .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ?")
    .get(projectId);
  return Promise.resolve(
    project
      ? { ok: true, value: { authorized: true as const } }
      : failure("PROJECT_NOT_FOUND", "The project was not found."),
  );
}

function decodeAccessToken(value: Uint8Array): Result<string> {
  const decoded = new TextDecoder().decode(value).trim();
  let token = decoded;
  if (decoded.startsWith("{")) {
    try {
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      token = typeof parsed.accessToken === "string" ? parsed.accessToken : "";
    } catch {
      token = "";
    }
  }
  return token && token.length <= 4_096 && !/\s/u.test(token)
    ? { ok: true, value: token }
    : failure("CONNECTOR_CREDENTIAL_INVALID", "Connector credentials are unavailable.");
}

function createDatabaseGitHubPort(input: Dependencies): GitHubPort {
  const tokenCaches = new Map<string, GitHubInstallationTokenCache>();
  const selectedRepositories = (scope: ConnectorScope) =>
    input.database
      .query<{ repository_id: string }, [string, string]>(
        `SELECT repository_id FROM github_selected_repositories
         WHERE project_id = ? AND connector_id = ? AND scope_state = 'SELECTED'
         ORDER BY repository_id`,
      )
      .all(scope.projectId, scope.connectorId)
      .map((row) => row.repository_id);
  const selectedProjects = (scope: ConnectorScope) =>
    input.database
      .query<{ github_project_node_id: string }, [string, string]>(
        `SELECT github_project_node_id FROM github_selected_projects
         WHERE project_id = ? AND connector_id = ? AND scope_state = 'SELECTED'
         ORDER BY github_project_node_id`,
      )
      .all(scope.projectId, scope.connectorId)
      .map((row) => row.github_project_node_id);
  const repository = (scope: ConnectorScope, repositoryId: string) => {
    const row = input.database
      .query<
        { repository_id: string; repository_node_id: string; owner_login: string; name: string },
        [string, string, string]
      >(
        `SELECT repository_id, repository_node_id, owner_login, name
         FROM github_selected_repositories
         WHERE project_id = ? AND connector_id = ? AND repository_id = ?
           AND scope_state = 'SELECTED'`,
      )
      .get(scope.projectId, scope.connectorId, repositoryId);
    return row
      ? {
          ok: true as const,
          value: {
            repositoryId: row.repository_id,
            nodeId: row.repository_node_id,
            owner: row.owner_login,
            name: row.name,
          },
        }
      : failure("GITHUB_REPOSITORY_NOT_SELECTED", "GitHub provider operation failed.");
  };
  const token = async (scope: ConnectorScope): Promise<Result<string>> => {
    const installation = input.database
      .query<
        {
          app_id: string;
          installation_id: string;
          private_key_credential_id: string;
          epoch: number;
        },
        [string]
      >(
        `SELECT installation.app_id, installation.installation_id,
                installation.private_key_credential_id, epoch.epoch
         FROM github_installations AS installation
         JOIN connector_epochs AS epoch ON epoch.connector_id = installation.connector_id
         WHERE installation.connector_id = ? AND epoch.review_state = 'READY'`,
      )
      .get(scope.connectorId);
    if (!installation || installation.epoch !== scope.connectorEpoch)
      return failure("GITHUB_NOT_CONFIGURED", "GitHub is not configured.", "REFRESH");
    const repositoryIds = selectedRepositories(scope);
    const permissions = {
      checks: "read",
      contents: "read",
      issues: "write",
      metadata: "read",
      organization_projects: "write",
      pull_requests: "read",
    } as const;
    const cache = tokenCaches.get(scope.connectorId) ?? new GitHubInstallationTokenCache();
    tokenCaches.set(scope.connectorId, cache);
    const issued = await cache.get({
      connectorId: scope.connectorId,
      connectorEpoch: scope.connectorEpoch,
      scopeDigest: digest(repositoryIds),
      permissionDigest: digest(permissions),
      now: Date.now(),
      issue: async () => {
        const privateKey = await input.credentials.openCredential(
          installation.private_key_credential_id,
        );
        if (!privateKey.ok) return privateKey;
        const jwt = createGitHubAppJwt({
          appId: installation.app_id,
          privateKey: privateKey.value,
          now: Date.now(),
        });
        if (!jwt.ok) return jwt;
        return requestInstallationToken({
          appJwt: jwt.value,
          installationId: installation.installation_id,
          repositoryIds,
          permissions,
        });
      },
    });
    return issued.ok ? { ok: true, value: issued.value.token } : issued;
  };
  const provider = (scope: ConnectorScope) =>
    createGitHubRestProvider({
      connectorId: scope.connectorId,
      clock: input.clock,
      token,
      selectedRepositoryIds: selectedRepositories,
      selectedProjectIds: selectedProjects,
      repository: (repositoryId) => repository(scope, repositoryId),
      async workItemNodeId(reference: GitHubWorkItemReference) {
        const metadata = repository(scope, reference.repositoryId);
        if (!metadata.ok) return metadata;
        const access = await token(scope);
        if (!access.ok) return access;
        try {
          const response = await fetch(
            `https://api.github.com/repos/${encodeURIComponent(metadata.value.owner)}/${encodeURIComponent(metadata.value.name)}/issues/${reference.number}`,
            { headers: { ...GITHUB_REST_HEADERS, authorization: `Bearer ${access.value}` } },
          );
          if (!response.ok)
            return failure("GITHUB_MISSING", "GitHub provider operation failed.", "REFRESH");
          const text = await response.text();
          if (text.length > 1_048_576)
            return failure("GITHUB_RESPONSE_TOO_LARGE", "GitHub provider operation failed.");
          const nodeId = (JSON.parse(text) as Record<string, unknown>).node_id;
          return typeof nodeId === "string" && nodeId.length <= 128
            ? { ok: true, value: nodeId }
            : failure("GITHUB_RESPONSE_INVALID", "GitHub provider operation failed.");
        } catch {
          return failure("GITHUB_UNAVAILABLE", "GitHub provider operation failed.", "SAME_INPUT");
        }
      },
    });
  return {
    inspect: (scope, reference) => provider(scope).inspect(scope, reference),
    mutate: (authorization, command) => {
      const scope: ConnectorScope = {
        projectId: command.projectId,
        connectorId: command.connectorId,
        connectorEpoch: command.connectorEpoch,
        references: [authorization.reference],
        operations: [authorization.operation],
      };
      return provider(scope).mutate(authorization, command);
    },
    async *scan(scope: ConnectorScope, cursor?: ReconciliationCursor) {
      yield* provider(scope).scan(scope, cursor);
    },
    observeChecks: (scope, reference) => provider(scope).observeChecks(scope, reference),
    listDependencies: (scope, reference) => provider(scope).listDependencies(scope, reference),
  };
}

function inboxItems(database: Database, memberId: string): readonly InboxItem[] {
  return database
    .query<
      {
        recipient_member_id: string;
        event_type: InboxItem["eventType"];
        event_id: string;
        subject_key: string;
        category: InboxItem["category"];
        material_digest: string;
        safe_summary: string;
        unread: number;
        created_at: number;
        updated_at: number;
        revision: number;
      },
      [string]
    >(
      `SELECT recipient_member_id, event_type, event_id, subject_key, category,
              material_digest, safe_summary, unread, created_at, updated_at, revision
       FROM inbox_items WHERE recipient_member_id = ? AND resolved_at IS NULL
       ORDER BY unread DESC, updated_at DESC LIMIT 200`,
    )
    .all(memberId)
    .map((row) => ({
      recipientMemberId: row.recipient_member_id,
      eventType: row.event_type,
      eventId: row.event_id,
      subjectKey: row.subject_key,
      category: row.category,
      materialDigest: row.material_digest,
      safeSummary: row.safe_summary,
      unread: Boolean(row.unread),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
    }));
}

function createOutlineResources(input: Dependencies): NonNullable<ServerResources["outline"]> {
  const contentFor = (connectorId: string): Result<OutlineContentPort> => {
    if (!input.environment.outlineBaseUrl || !input.environment.outlineTokenFile)
      return failure("OUTLINE_NOT_CONFIGURED", "Outline is not configured.", "REFRESH");
    const configuredOrigin = new URL(input.environment.outlineBaseUrl).origin;
    const connection = input.database
      .query<{ origin: string; workspace_id: string }, [string, string]>(
        `SELECT connection.origin, connection.workspace_id FROM outline_connections AS connection
         JOIN connector_epochs AS epoch ON epoch.connector_id = connection.connector_id
         WHERE connection.connector_id = ? AND connection.origin = ?
           AND epoch.review_state = 'READY'`,
      )
      .get(connectorId, configuredOrigin);
    if (!connection)
      return failure("OUTLINE_NOT_CONFIGURED", "Outline is not configured.", "REFRESH");
    const transport = createOutlineFetchTransport({
      baseUrl: input.environment.outlineBaseUrl,
      readToken: () => readOutlineTokenFile(input.environment.outlineTokenFile as string),
    });
    return {
      ok: true,
      value: createProductionOutlineContent({
        workspaceId: connection.workspace_id,
        transport,
        clock: input.clock,
        memberAccessToken: async (authorization: ConnectorOperationAuthorization) => {
          const actor = input.database
            .query<{ actor_id: string; actor_kind: string }, [string, string]>(
              `SELECT actor_id, actor_kind FROM connector_operation_authorizations
               WHERE id = ? AND connector_id = ? AND state = 'RESERVED'`,
            )
            .get(authorization.id, authorization.connectorId);
          if (actor?.actor_kind !== "MEMBER")
            return failure(
              "OUTLINE_MEMBER_GRANT_REQUIRED",
              "A delegated member grant is required.",
            );
          const grant = input.database
            .query<{ credential_id: string }, [string, string, number]>(
              `SELECT grant.credential_id FROM outline_member_oauth_grants AS grant
               JOIN members AS member ON member.id = grant.member_id AND member.status = 'ACTIVE'
               JOIN encrypted_credentials AS credential
                 ON credential.id = grant.credential_id AND credential.revoked_at IS NULL
                 AND credential.revision = grant.credential_revision
               JOIN connector_epochs AS epoch
                 ON epoch.connector_id = grant.connector_id AND epoch.review_state = 'READY'
               WHERE grant.connector_id = ? AND grant.member_id = ?
                 AND grant.refresh_status = 'READY' AND grant.revoked_at IS NULL
                 AND grant.access_expires_at > ?`,
            )
            .get(authorization.connectorId, actor.actor_id, Date.now());
          if (!grant)
            return failure(
              "OUTLINE_MEMBER_GRANT_REQUIRED",
              "A delegated member grant is required.",
            );
          const credential = await input.credentials.openCredential(grant.credential_id);
          return credential.ok ? decodeAccessToken(credential.value) : credential;
        },
      }),
    };
  };
  const dynamicContent: OutlineContentPort = {
    async search(scope, query) {
      const content = contentFor(scope.connectorId);
      return content.ok ? content.value.search(scope, query) : content;
    },
    async read(scope, reference) {
      const content = contentFor(scope.connectorId);
      return content.ok ? content.value.read(scope, reference) : content;
    },
    async mutate(authorization, command) {
      const content = contentFor(command.connectorId);
      return content.ok ? content.value.mutate(authorization, command) : content;
    },
  };
  const sourceConnector = {
    async inspect() {
      return failure("OUTLINE_INSPECTION_UNAVAILABLE", "Outline inspection is unavailable.");
    },
    mutate: (
      authorization: ConnectorOperationAuthorization,
      command: ExactRevisionMutation<OutlineMutation>,
    ) => dynamicContent.mutate(authorization, command),
    async *scan() {
      yield failure("OUTLINE_RECONCILIATION_UNAVAILABLE", "Outline reconciliation is unavailable.");
    },
  };
  const notConfigured = async () =>
    failure("OUTLINE_OAUTH_NOT_CONFIGURED", "Outline OAuth is not configured.", "REFRESH");
  const search = async (actor: MemberActor, value: unknown) => {
    const request = value as Readonly<{
      projectId?: string;
      connectorId?: string;
      query?: Parameters<OutlineContentPort["search"]>[1];
    }>;
    if (!request.projectId || !request.connectorId || !request.query)
      return failure("OUTLINE_REQUEST_INVALID", "The Outline request is invalid.");
    const scope = input.connectorAuthority.currentScopeNow(request.projectId, request.connectorId);
    if (!scope.ok) return scope;
    const project = await authorizeProject(input.database, actor, request.projectId);
    return project.ok ? dynamicContent.search(scope.value, request.query) : project;
  };
  const read = async (actor: MemberActor, value: unknown) => {
    const request = value as Readonly<{
      projectId?: string;
      connectorId?: string;
      reference?: OutlineReference;
    }>;
    if (!request.projectId || !request.connectorId || !request.reference)
      return failure("OUTLINE_REQUEST_INVALID", "The Outline request is invalid.");
    const scope = input.connectorAuthority.currentScopeNow(request.projectId, request.connectorId);
    if (!scope.ok) return scope;
    const project = await authorizeProject(input.database, actor, request.projectId);
    return project.ok ? dynamicContent.read(scope.value, request.reference) : project;
  };
  const mutate = async (
    actor: MemberActor,
    value: unknown,
    expectedKind: "CREATE_DOCUMENT_AS_MEMBER" | "EDIT_DOCUMENT_AS_MEMBER",
  ) => {
    const command = value as ExactRevisionMutation<OutlineMutation>;
    if (!command?.mutation || command.mutation.kind !== expectedKind)
      return failure("OUTLINE_MUTATION_UNSUPPORTED", "Outline mutation is unsupported.");
    if (command.mutation.kind === "CREATE_DOCUMENT_AS_MEMBER") {
      return input.connectorAuthority.mutateAsMember(sourceConnector, {
        actor,
        reference: `OUTLINE_COLLECTION:${command.mutation.collectionId}`,
        operation: "CREATE_DOCUMENT",
        command,
      });
    }
    if (command.mutation.kind === "EDIT_DOCUMENT_AS_MEMBER") {
      return input.connectorAuthority.mutateAsMember(sourceConnector, {
        actor,
        reference: command.mutation.documentId,
        operation: "EDIT_CONTENT",
        command,
      });
    }
    return failure("OUTLINE_MUTATION_UNSUPPORTED", "Outline mutation is unsupported.");
  };
  const configuredOrigin = input.environment.outlineBaseUrl
    ? new URL(input.environment.outlineBaseUrl).origin
    : undefined;
  const configured = Boolean(
    configuredOrigin &&
      input.environment.outlineTokenFile &&
      input.database
        .query<{ count: number }, [string]>(
          `SELECT count(*) AS count FROM outline_connections AS connection
           JOIN connector_epochs AS epoch ON epoch.connector_id = connection.connector_id
           WHERE connection.origin = ? AND epoch.review_state = 'READY'`,
        )
        .get(configuredOrigin)?.count,
  );
  return {
    state: configured ? "OPERATIONAL" : "NOT_CONFIGURED",
    authorization: {
      authorizeProject: (actor, projectId) => authorizeProject(input.database, actor, projectId),
    },
    connector: { begin: notConfigured, finish: notConfigured, revoke: notConfigured },
    search: {
      async authorize(actor, projectId, connectorId) {
        const scope = input.connectorAuthority.currentScopeNow(projectId, connectorId);
        return scope.ok
          ? {
              ok: true,
              value: {
                actor: { kind: "MEMBER", memberId: actor.memberId },
                scope: scope.value,
                query: {} as never,
              },
            }
          : scope;
      },
      async search(command) {
        return dynamicContent.search(command.scope, command.query);
      },
    },
    documents: {
      create: (actor, command) => mutate(actor, command, "CREATE_DOCUMENT_AS_MEMBER"),
      edit: (actor, command) => mutate(actor, command, "EDIT_DOCUMENT_AS_MEMBER"),
    },
    mcp: { search, read },
  };
}

export function createPackagedConnectorResources(
  input: Dependencies,
): Pick<ServerResources, "github" | "outline" | "inbox" | "startup" | "shutdown"> {
  const github = createDatabaseGitHubPort(input);
  const inbox = {
    authentication: input.authentication,
    rateLimits: input.rateLimits,
    async listInbox(actor: MemberActor) {
      return { ok: true as const, value: inboxItems(input.database, actor.memberId) };
    },
    async listCommandCenter(actor: MemberActor) {
      return {
        ok: true as const,
        value: inboxItems(input.database, actor.memberId).map(commandCenterCard),
      };
    },
  };
  const webhooks = {
    async receive(connectorId: string, request: Request) {
      const row = input.database
        .query<{ webhook_secret_credential_id: string; epoch: number }, [string]>(
          `SELECT installation.webhook_secret_credential_id, epoch.epoch
           FROM github_installations AS installation
           JOIN connector_epochs AS epoch ON epoch.connector_id = installation.connector_id
           WHERE installation.connector_id = ? AND epoch.review_state = 'READY'`,
        )
        .get(connectorId);
      if (!row) return failure("GITHUB_NOT_CONFIGURED", "GitHub is not configured.", "REFRESH");
      const secret = await input.credentials.openCredential(row.webhook_secret_credential_id);
      if (!secret.ok) return secret;
      const projectIds = input.database
        .query<{ project_id: string }, [string]>(
          "SELECT project_id FROM github_project_connectors WHERE connector_id = ? ORDER BY project_id",
        )
        .all(connectorId)
        .map((project) => project.project_id);
      return consumeVerifiedGitHubWebhook(
        request,
        secret.value,
        { maxBodyBytes: 1_048_576 },
        async (delivery) =>
          recordVerifiedGitHubDelivery({
            database: input.database,
            connectorId,
            projectIds,
            delivery,
            receivedAt: input.clock(),
          }),
      );
    },
  };
  const composition = createGitHubProductionComposition({
    database: input.database,
    clock: input.clock,
    connectorAuthority: input.connectorAuthority,
    github,
    authentication: input.authentication,
    rateLimits: input.rateLimits,
    runs: input.runs,
    configuredOrigin: input.environment.publicBaseUrl,
    webhooks,
    planning: {
      authentication: input.authentication,
      rateLimits: input.rateLimits,
      authorizeProject: (actor, projectId) => authorizeProject(input.database, actor, projectId),
      async list(_actor, projectId) {
        const rows = input.database
          .query<{ projection_json: string }, [string]>(
            `SELECT projection.projection_json FROM connector_projections AS projection
             JOIN connector_provider_bindings AS binding ON binding.connector_id = projection.connector_id
             WHERE projection.project_id = ? AND binding.provider = 'GITHUB'
               AND projection.freshness <> 'REDACTED'
             ORDER BY projection.reference`,
          )
          .all(projectId);
        const values = rows.flatMap((row) => {
          try {
            const parsed = GitHubProjectionSchema.safeParse(JSON.parse(row.projection_json));
            return parsed.success ? [parsed.data] : [];
          } catch {
            return [];
          }
        });
        return { ok: true, value: values };
      },
    },
    inbox,
    scope: (projectId, connectorId) =>
      input.connectorAuthority.currentScopeNow(projectId, connectorId),
    reconcile: (scope, cursor, onProgress) =>
      reconcileGitHubScope({
        github,
        connectorAuthority: input.connectorAuthority,
        scope,
        ...(cursor ? { cursor } : {}),
        onProgress,
      }),
  });
  const configured = Boolean(
    input.database
      .query<{ count: number }, []>(
        `SELECT count(*) AS count FROM github_installations AS installation
         JOIN connector_epochs AS epoch ON epoch.connector_id = installation.connector_id
         WHERE epoch.review_state = 'READY'`,
      )
      .get()?.count,
  );
  const githubResources = composition.resources.github;
  if (!githubResources) throw new Error("GITHUB_PRODUCTION_RESOURCES_REQUIRED");
  return {
    github: { ...githubResources, state: configured ? "OPERATIONAL" : "NOT_CONFIGURED" },
    outline: createOutlineResources(input),
    inbox,
    startup: composition.resources.startup,
    shutdown: composition.resources.shutdown,
  };
}
