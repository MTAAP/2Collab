import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "./app.ts";
import {
  createProductionServer,
  type ProductionRunnerInfrastructure,
} from "./adapters/wss/production-bootstrap.ts";
import type { PublicAuthenticationPort } from "./adapters/http/middleware/authentication.ts";
import type { PublicRateLimitPort } from "./adapters/http/middleware/request-limits.ts";
import type { FoundationHttpDependencies } from "./adapters/http/app.ts";
import {
  createHmacPermitCodec,
  deriveDeploymentMasterKey,
} from "./modules/execution-authority/permit-codec.ts";
import {
  createRunnerKeyProofPort,
  createRunnerRequestProofPort,
} from "./modules/runners/runner-cryptography.ts";
import { createExecutionAuthorityRunOperations } from "./modules/public-surface/run-operations.ts";
import type { ServerEnvironment } from "../shared/environment.ts";
import type { Result } from "../shared/contracts/result.ts";
import { createMcpHttpHandler } from "./adapters/mcp/http.ts";
import type { GitHubWebhookRouteDependencies } from "./adapters/http/routes/connectors-github.ts";
import type { GitHubIssueRouteDependencies } from "./adapters/http/routes/github-issues.ts";
import type { createGitHubPlanningRoutes } from "./adapters/http/routes/github-planning.ts";
import type { createInboxRoutes } from "./adapters/http/routes/inbox.ts";
import type { PublicRunOperations } from "./modules/public-surface/contract.ts";
import type { MemberActor } from "../shared/contracts/actors.ts";
import type { GitHubMutation, GitHubProjection } from "../shared/contracts/github.ts";
import type { ExactRevisionMutation, Observed } from "./modules/connectors/contract.ts";
import { openDatabase } from "./db/connection.ts";
import { migrate } from "./db/migrate.ts";
import { createSessionAuthority } from "./modules/identity/sessions.ts";
import { verifyCsrf } from "./modules/identity/csrf.ts";
import type { ExecutionAuthority } from "../shared/contracts/execution-authority.ts";

export type ServerResources = Readonly<{
  docsRoot?: string;
  github?: Readonly<{
    webhooks: GitHubWebhookRouteDependencies;
    issues: GitHubIssueRouteDependencies;
    planning: Parameters<typeof createGitHubPlanningRoutes>[0];
    mcp?: Readonly<{
      mutate(
        actor: MemberActor,
        command: ExactRevisionMutation<GitHubMutation>,
      ): Promise<Result<Observed<GitHubProjection>>>;
    }>;
  }>;
  inbox?: Parameters<typeof createInboxRoutes>[0];
  foundation?: Readonly<{
    authentication: PublicAuthenticationPort;
    rateLimits: PublicRateLimitPort;
    runs: PublicRunOperations;
    mcp?: (request: Request) => Promise<Response>;
  }>;
  startup?: () => Promise<void> | void;
  webRoot?: string;
  outline?: NonNullable<FoundationHttpDependencies["outline"]> &
    Readonly<{
      mcp: Readonly<{
        search(
          actor: import("../shared/contracts/actors.ts").MemberActor,
          input: unknown,
        ): Promise<unknown>;
        read(
          actor: import("../shared/contracts/actors.ts").MemberActor,
          input: unknown,
        ): Promise<unknown>;
      }>;
    }>;
  automation?: Readonly<{
    workflows: import("./modules/workflows/authoring.ts").WorkflowAuthoringOperations;
    templates: import("./modules/templates/bindings.ts").TemplateBindingOperations;
  }>;
}>;

function defaultSecurityDigest(): string {
  return new Bun.CryptoHasher("sha256").update("2collab").digest("hex");
}

function boundedRateLimits(clock: () => number): PublicRateLimitPort {
  const windows = new Map<string, { startedAt: number; count: number }>();
  return {
    allow: ({ actorId, method, path }) => {
      const key = `${actorId}:${method}:${path}`;
      const now = clock();
      const current = windows.get(key);
      if (!current || now - current.startedAt >= 60) {
        windows.set(key, { startedAt: now, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= 120;
    },
  };
}

function databaseBrowserAuthentication(
  database: ReturnType<typeof openDatabase>,
  clock: () => number,
  configuredOrigin: string,
): PublicAuthenticationPort {
  const sessions = createSessionAuthority({
    database,
    clock,
    id: (prefix) => `${prefix}_${randomBytes(24).toString("base64url")}`,
  });
  const csrfByRequest = new WeakMap<Request, Uint8Array>();
  const cookie = (request: Request) => {
    const value = /(?:^|;\s*)collab_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    const separator = value?.indexOf(".") ?? -1;
    return value && separator > 0
      ? { sessionId: value.slice(0, separator), sessionProof: value.slice(separator + 1) }
      : null;
  };
  return {
    async authenticateBrowser(request) {
      const credential = cookie(request);
      if (!credential)
        return {
          ok: false,
          error: {
            code: "SESSION_REQUIRED",
            message: "Member session is required.",
            retry: "NEVER",
          },
        };
      const verified = await sessions.verifyCookie(credential);
      if (!verified.ok) return verified;
      csrfByRequest.set(request, verified.value.csrfHash);
      return {
        ok: true,
        value: {
          kind: "MEMBER",
          memberId: verified.value.memberId as never,
          sessionId: credential.sessionId as never,
          sessionProof: credential.sessionProof,
        },
      };
    },
    async authenticateDevice() {
      return {
        ok: false,
        error: {
          code: "DEVICE_AUTHENTICATION_REQUIRED",
          message: "Device authentication is required.",
          retry: "NEVER",
        },
      };
    },
    verifyBrowserMutation(request) {
      const csrfHash = csrfByRequest.get(request);
      return (
        !!csrfHash &&
        verifyCsrf(csrfHash, request.headers.get("x-collab-csrf") ?? "", {
          origin: request.headers.get("origin"),
          method: request.method,
          contentType: request.headers.get("content-type"),
          configuredOrigin,
        })
      );
    },
  };
}

async function loadDeploymentMasterKey(environment: ServerEnvironment): Promise<Uint8Array> {
  if (environment.deploymentMasterKeyFile) {
    return deriveDeploymentMasterKey(environment.deploymentMasterKeyFile);
  }
  if (environment.mode === "development") {
    return new Uint8Array(randomBytes(32));
  }
  throw new Error("DEPLOYMENT_MASTER_KEY_FILE_REQUIRED");
}

export async function createServerDependencies(
  environment: ServerEnvironment,
  resources: ServerResources = {},
) {
  const clock = () => Math.floor(Date.now() / 1_000);
  const directory = resolve(environment.dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = openDatabase(join(directory, "collab.sqlite"));
  migrate(database);
  const deploymentMasterKey = await loadDeploymentMasterKey(environment);
  const permitCodec = createHmacPermitCodec(deploymentMasterKey);
  const runnerKeyProof = createRunnerKeyProofPort();
  const runnerRequestProof = createRunnerRequestProofPort();
  const securityDigest = defaultSecurityDigest();
  const now = Math.floor(Date.now() / 1_000);

  const runnerInfrastructure: ProductionRunnerInfrastructure = {
    runnerKeyProof,
    runnerRequestProof,
    authorityFacts: {
      preview: async () => ({
        ok: true,
        value: {
          refreshedAt: now,
          profileFingerprint: securityDigest,
        },
      }),
      refresh: async () => ({
        ok: true,
        value: {
          projectRevision: 1,
          runnerOwnerMemberId: "owner_1",
          runnerPolicyRevision: 1,
          profileVersion: 1,
          profileFingerprint: securityDigest,
          authorizationSource: "OWNER",
          securityPolicyVersion: 1,
          securityDigest,
          resolvedBaseCommit: "a".repeat(40),
          baseBranch: "refs/heads/trunk",
          permitSeconds: 30,
          authoritySessionSeconds: 30,
          authorityRenewalSeconds: 10,
          mutationDisconnectGraceSeconds: 15,
          maximumAttempts: 3,
          deadlineAt: now + 900,
          connectorEpochs: {},
        },
      }),
    },
    runConfiguration: {
      resolve: async () => ({
        ok: false,
        error: {
          code: "RUN_CONFIGURATION_NOT_IMPLEMENTED",
          message: "Run configuration resolution is not implemented.",
          retry: "NEVER",
        },
      }),
    },
    permitCodec,
    defaultSecurityDigest: securityDigest,
    acceptGateEvent: async () => ({
      ok: false,
      error: {
        code: "GATE_EVENT_NOT_IMPLEMENTED",
        message: "Gate events are not implemented.",
        retry: "NEVER",
      },
    }),
  };

  const configuredOrigin = environment.publicBaseUrl;
  const authentication =
    resources.foundation?.authentication ??
    databaseBrowserAuthentication(database, clock, environment.publicBaseUrl);
  const rateLimits = resources.foundation?.rateLimits ?? boundedRateLimits(clock);
  let boundAuthority: ExecutionAuthority | undefined;
  const authorityDelegate = {
    preview: (request: never) => {
      if (!boundAuthority) throw new Error("EXECUTION_AUTHORITY_UNAVAILABLE");
      return boundAuthority.preview(request);
    },
    execute: (command: never) => {
      if (!boundAuthority) throw new Error("EXECUTION_AUTHORITY_UNAVAILABLE");
      return boundAuthority.execute(command);
    },
    query: (query: never) => {
      if (!boundAuthority) throw new Error("EXECUTION_AUTHORITY_UNAVAILABLE");
      return boundAuthority.query(query);
    },
  } as ExecutionAuthority;
  const runs =
    resources.foundation?.runs ??
    createExecutionAuthorityRunOperations({
      authority: authorityDelegate,
      resolveLaunch: async () => ({
        ok: false,
        error: {
          code: "RUN_CONFIGURATION_UNAVAILABLE",
          message: "Run configuration could not be resolved from current provider state.",
          retry: "REFRESH",
        },
      }),
    });
  const dependencies: FoundationHttpDependencies = {
    configuredOrigin,
    authentication,
    rateLimits,
    runs,
    readiness: { ready: () => boundAuthority !== undefined },
    mcp:
      resources.foundation?.mcp ??
      createMcpHttpHandler({
        authentication,
        rateLimits,
        runs,
        ...(resources.outline ? { outlineMcp: resources.outline.mcp } : {}),
        ...(resources.github?.mcp ? { github: resources.github.mcp } : {}),
        ...(resources.automation ? resources.automation : {}),
      }),
    ...(resources.outline ? { outline: resources.outline } : {}),
  };
  const app = createApp(dependencies, {
    docsRoot: resources.docsRoot,
    githubWebhooks: resources.github?.webhooks,
    githubIssues: resources.github?.issues,
    githubPlanning: resources.github?.planning,
    inbox: resources.inbox,
    automation: resources.automation
      ? { authentication, rateLimits, ...resources.automation }
      : undefined,
    webRoot: resources.webRoot,
  });

  const server = await createProductionServer(environment, app, {
    database,
    infrastructure: runnerInfrastructure,
  });
  boundAuthority = server.authority;
  await resources.startup?.();
  return server;
}

/** Packaged production root; retained legacy name above is an import-compatible seam for tests. */
export const createProductionComposition = createServerDependencies;
