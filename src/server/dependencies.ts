import { randomBytes } from "node:crypto";
import { createApp } from "./app.ts";
import {
  createProductionServer,
  installProductionRunnerInfrastructure,
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
import { createStubRunOperations } from "./modules/public-surface/run-operations.ts";
import type { ServerEnvironment } from "../shared/environment.ts";
import type { Result } from "../shared/contracts/result.ts";
import { createMcpHttpHandler } from "./adapters/mcp/http.ts";
import type { GitHubWebhookRouteDependencies } from "./adapters/http/routes/connectors-github.ts";
import type { GitHubIssueRouteDependencies } from "./adapters/http/routes/github-issues.ts";
import type { createGitHubPlanningRoutes } from "./adapters/http/routes/github-planning.ts";

export type ServerResources = Readonly<{
  docsRoot?: string;
  github?: Readonly<{
    webhooks: GitHubWebhookRouteDependencies;
    issues: GitHubIssueRouteDependencies;
    planning: Parameters<typeof createGitHubPlanningRoutes>[0];
  }>;
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
}>;

function defaultSecurityDigest(): string {
  return new Bun.CryptoHasher("sha256").update("2collab").digest("hex");
}

function notImplementedAuthentication(): PublicAuthenticationPort {
  return {
    authenticateBrowser: async () =>
      ({
        ok: false,
        error: {
          code: "SESSION_REQUIRED",
          message: "Browser session is required.",
          retry: "NEVER",
        },
      }) as Result<never>,
    authenticateDevice: async () =>
      ({
        ok: false,
        error: {
          code: "DEVICE_AUTHENTICATION_REQUIRED",
          message: "Device authentication is required.",
          retry: "NEVER",
        },
      }) as Result<never>,
    verifyBrowserMutation: () => false,
  };
}

function allowAllRateLimits(): PublicRateLimitPort {
  return {
    allow: () => true,
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
  const deploymentMasterKey = await loadDeploymentMasterKey(environment);
  const permitCodec = createHmacPermitCodec(deploymentMasterKey);
  const runnerKeyProof = createRunnerKeyProofPort();
  const runnerRequestProof = createRunnerRequestProofPort();
  const securityDigest = defaultSecurityDigest();
  const now = Math.floor(Date.now() / 1_000);

  installProductionRunnerInfrastructure({
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
  });

  const configuredOrigin = environment.publicBaseUrl;
  const authentication = notImplementedAuthentication();
  const runs = createStubRunOperations();
  const dependencies: FoundationHttpDependencies = {
    configuredOrigin,
    authentication,
    rateLimits: allowAllRateLimits(),
    runs,
    mcp: createMcpHttpHandler({
      authentication,
      runs,
      ...(resources.outline ? { outlineMcp: resources.outline.mcp } : {}),
    }),
    ...(resources.outline ? { outline: resources.outline } : {}),
  };
  const app = createApp(dependencies, {
    docsRoot: resources.docsRoot,
    githubWebhooks: resources.github?.webhooks,
    githubIssues: resources.github?.issues,
    githubPlanning: resources.github?.planning,
    webRoot: resources.webRoot,
  });

  return createProductionServer(environment, app);
}
