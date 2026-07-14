import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MemberActor } from "../shared/contracts/actors.ts";
import type { CollabCommand, LaunchRun } from "../shared/contracts/commands.ts";
import type { ExecutionAuthority } from "../shared/contracts/execution-authority.ts";
import type { GitHubMutation, GitHubProjection } from "../shared/contracts/github.ts";
import { GitHubProjectionSchema } from "../shared/contracts/github.ts";
import { OutlineDocumentProjectionSchema } from "../shared/contracts/outline.ts";
import type { Result } from "../shared/contracts/result.ts";
import { verifyDpopProof } from "../shared/dpop.ts";
import type { ServerEnvironment } from "../shared/environment.ts";
import type { FoundationHttpDependencies } from "./adapters/http/app.ts";
import type { PublicAuthenticationPort } from "./adapters/http/middleware/authentication.ts";
import type { PublicRateLimitPort } from "./adapters/http/middleware/request-limits.ts";
import type { GitHubWebhookRouteDependencies } from "./adapters/http/routes/connectors-github.ts";
import type { GitHubIssueRouteDependencies } from "./adapters/http/routes/github-issues.ts";
import type { createGitHubPlanningRoutes } from "./adapters/http/routes/github-planning.ts";
import type { createInboxRoutes } from "./adapters/http/routes/inbox.ts";
import { createMcpHttpHandler } from "./adapters/mcp/http.ts";
import {
  createProductionServer,
  type ProductionRunnerInfrastructure,
} from "./adapters/wss/production-bootstrap.ts";
import { createApp } from "./app.ts";
import { openDatabase } from "./db/connection.ts";
import { migrate } from "./db/migrate.ts";
import { inImmediateTransaction } from "./db/transaction.ts";
import type { ExactRevisionMutation, Observed } from "./modules/connectors/contract.ts";
import { createProjectionCodec } from "./modules/connectors/contract.ts";
import { createConnectorAuthority } from "./modules/connectors/connector-authority.ts";
import type { RefreshedAuthorityFacts } from "./modules/execution-authority/execution-authority.ts";
import {
  createHmacPermitCodec,
  deriveDeploymentMasterKey,
} from "./modules/execution-authority/permit-codec.ts";
import { createGateCoordinator } from "./modules/gates/evaluations.ts";
import { verifyCsrf } from "./modules/identity/csrf.ts";
import { createDeviceAuthority } from "./modules/identity/devices.ts";
import { createIdentityAuthority } from "./modules/identity/identity-authority.ts";
import { createDpopVerifier, createSessionAuthority } from "./modules/identity/sessions.ts";
import {
  prepareRunConfigurationSnapshot,
  resolveEffectiveRunConfiguration,
} from "./modules/presets/configuration-resolver.ts";
import { resolveExactPersonalRunPresetVersion } from "./modules/presets/personal-run-presets.ts";
import type { PublicRunOperations } from "./modules/public-surface/contract.ts";
import { createExecutionAuthorityRunOperations } from "./modules/public-surface/run-operations.ts";
import {
  createRunnerKeyProofPort,
  createRunnerRequestProofPort,
} from "./modules/runners/runner-cryptography.ts";
import { createWorkflowUsageStore } from "./modules/telemetry/workflow-usage.ts";
import { createTemplateRegistry } from "./modules/templates/versioning.ts";
import { createWorkflowAuthoringOperations } from "./modules/workflows/authoring.ts";
import { createWorkflowDraftStore } from "./modules/workflows/drafts.ts";
import { createManagedLoopStore } from "./modules/workflows/managed-loops.ts";
import { createPlanArtifactStore } from "./modules/workflows/planning.ts";
import type { WorkflowRuntimeOperations } from "./modules/workflows/runtime-operations.ts";
import { createWorkflowScheduler } from "./modules/workflows/scheduler.ts";
import { createWorkflowEngine } from "./modules/workflows/workflow-engine.ts";
import { createConnectorAttemptAuthority } from "./modules/execution-authority/fencing.ts";
import { createCredentialKeyManager } from "./operations/key-rotation.ts";
import { createPackagedConnectorResources } from "./connector-production-composition.ts";

export type ServerResources = Readonly<{
  docsRoot?: string;
  github?: Readonly<{
    state?: "NOT_CONFIGURED" | "OPERATIONAL";
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
  shutdown?: () => Promise<void> | void;
  webRoot?: string;
  outline?: NonNullable<FoundationHttpDependencies["outline"]> &
    Readonly<{
      state?: "NOT_CONFIGURED" | "OPERATIONAL";
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
    runtime?: WorkflowRuntimeOperations;
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

export function canonicalPublicRequestUrl(request: Request, configuredOrigin: string): string {
  const internalUrl = new URL(request.url);
  const publicUrl = new URL(configuredOrigin);
  publicUrl.pathname = internalUrl.pathname;
  publicUrl.search = internalUrl.search;
  publicUrl.hash = "";
  return publicUrl.toString();
}

function databaseBrowserAuthentication(
  database: ReturnType<typeof openDatabase>,
  clock: () => number,
  configuredOrigin: string,
  devices?: ReturnType<typeof createDeviceAuthority>,
): PublicAuthenticationPort {
  const sessions = createSessionAuthority({
    database,
    clock,
    id: (prefix) => `${prefix}_${randomBytes(24).toString("base64url")}`,
  });
  const csrfByRequest = new WeakMap<Request, Uint8Array>();
  const dpop = createDpopVerifier({ database, clock, verifyProof: verifyDpopProof });
  const cookie = (request: Request) => {
    const value = /(?:^|;\s*)collab_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
    const separator = value?.indexOf(".") ?? -1;
    return value && separator > 0
      ? { sessionId: value.slice(0, separator), sessionProof: value.slice(separator + 1) }
      : null;
  };
  const authenticateRunnerDevice: NonNullable<
    PublicAuthenticationPort["authenticateRunnerDevice"]
  > = async (request) => {
    const authorization = request.headers.get("authorization") ?? "";
    const senderKeyThumbprint = request.headers.get("dpop-key-thumbprint") ?? "";
    const proof = request.headers.get("dpop") ?? "";
    const nonce = request.headers.get("dpop-nonce") ?? "";
    if (!devices || !authorization.startsWith("DPoP ") || proof.length < 1 || nonce.length < 1)
      return {
        ok: false,
        error: {
          code: "DEVICE_AUTHENTICATION_REQUIRED",
          message: "Device authentication is required.",
          retry: "NEVER",
        },
      };
    const verified = await devices.verifyAccess({
      accessToken: authorization.slice(5),
      senderKeyThumbprint,
    });
    if (!verified.ok) return verified;
    const accessTokenHash = new Bun.CryptoHasher("sha256")
      .update(authorization.slice(5))
      .digest("hex");
    const proofResult = await dpop.verify({
      proof,
      method: request.method,
      uri: canonicalPublicRequestUrl(request, configuredOrigin),
      nonce,
      senderKeyThumbprint,
      accessTokenHash,
    });
    return proofResult.ok ? verified : proofResult;
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
    async authenticateDevice(request) {
      const verified = await authenticateRunnerDevice(request);
      if (!verified.ok) return verified;
      return {
        ok: true,
        value: {
          kind: "MEMBER" as const,
          memberId: verified.value.memberId as never,
          sessionId: verified.value.deviceFamilyId as never,
          sessionProof: request.headers.get("dpop") ?? "",
        },
      };
    },
    authenticateRunnerDevice,
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
  const id = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;
  const credentials = createCredentialKeyManager({
    database,
    masterKey: deploymentMasterKey,
    masterKeyId: `master_${new Bun.CryptoHasher("sha256").update(deploymentMasterKey).digest("hex").slice(0, 32)}`,
    clock,
    id,
  });
  for (const credentialClass of ["PROVIDER", "MEMBER_OAUTH"] as const) {
    const initialized = await credentials.initializeClass(credentialClass);
    if (!initialized.ok) throw new Error(initialized.error.code);
  }

  const databaseAuthorityFacts = (command: CollabCommand): Result<RefreshedAuthorityFacts> => {
    if (command.kind !== "LAUNCH_RUN")
      return {
        ok: false,
        error: {
          code: "AUTHORITY_FACTS_UNAVAILABLE",
          message: "Current authority facts are unavailable.",
          retry: "REFRESH",
        },
      };
    const project = database
      .query<{ revision: number; base_branch: string }, [string]>(
        "SELECT revision, base_branch FROM projects WHERE id = ?",
      )
      .get(command.projectId);
    const runner = database
      .query<
        {
          owner_member_id: string;
          runner_epoch: number;
          policy_revision: number;
          security_policy_version: number;
          security_digest: string;
          revoked_at: number | null;
        },
        [string]
      >(
        "SELECT owner_member_id, runner_epoch, policy_revision, security_policy_version, security_digest, revoked_at FROM runners WHERE id = ?",
      )
      .get(command.execution.runnerId);
    const profile = database
      .query<{ fingerprint: string }, [string, string, number]>(
        "SELECT fingerprint FROM safe_profile_versions WHERE runner_id = ? AND profile_id = ? AND version = ?",
      )
      .get(
        command.execution.runnerId,
        command.execution.profileVersionId,
        command.execution.expectedProfileVersion,
      );
    const configurationBounds = database
      .query<{ maximum_attempts: number; deadline_seconds: number }, [string, number, string]>(
        `SELECT versions.maximum_attempts, versions.deadline_seconds
         FROM personal_run_preset_versions AS versions
         JOIN personal_run_presets AS presets ON presets.id = versions.preset_id
         WHERE versions.preset_id = ? AND versions.version = ?
           AND presets.state = 'ACTIVE'
           AND (presets.project_id IS NULL OR presets.project_id = ?)`,
      )
      .get(
        command.effectiveConfiguration.configurationId,
        command.effectiveConfiguration.version,
        command.projectId,
      );
    const exposure = command.execution.exposureRevision
      ? database
          .query<{ revision: number }, [string, string, number, string, number, number]>(
            `SELECT revision FROM runner_exposures WHERE runner_id = ? AND project_id = ?
             AND mapping_revision = ? AND profile_id = ? AND profile_version = ?
             AND revision = ? AND revoked_at IS NULL`,
          )
          .get(
            command.execution.runnerId,
            command.projectId,
            command.execution.projectMappingRevision,
            command.execution.profileVersionId,
            command.execution.expectedProfileVersion,
            command.execution.exposureRevision,
          )
      : undefined;
    const resolvedBaseCommit =
      command.repository.base.kind === "EXACT"
        ? command.repository.base.commitSha
        : database
            .query<{ base_commit: string }, [string, number, string, number, number]>(
              `SELECT observations.base_commit
               FROM runner_repository_observations AS observations
               JOIN runner_mapping_versions AS mappings
                 ON mappings.runner_id = observations.runner_id
                AND mappings.project_id = observations.project_id
                AND mappings.revision = observations.mapping_revision
                AND mappings.revoked_at IS NULL
               JOIN projects ON projects.id = observations.project_id
               WHERE observations.runner_id = ? AND observations.runner_epoch = ?
                 AND observations.project_id = ? AND observations.mapping_revision = ?
                 AND observations.base_branch = projects.base_branch
                 AND observations.observed_at > ?`,
            )
            .get(
              command.execution.runnerId,
              command.execution.expectedRunnerEpoch,
              command.projectId,
              command.execution.projectMappingRevision,
              clock() - 30,
            )?.base_commit;
    if (
      !project ||
      !runner ||
      runner.revoked_at !== null ||
      runner.runner_epoch !== command.execution.expectedRunnerEpoch ||
      !profile ||
      profile.fingerprint.length !== 64 ||
      !configurationBounds ||
      (command.execution.exposureRevision !== undefined && !exposure) ||
      !resolvedBaseCommit
    )
      return {
        ok: false,
        error: {
          code: resolvedBaseCommit ? "AUTHORITY_FACTS_STALE" : "REPOSITORY_BASE_UNAVAILABLE",
          message: resolvedBaseCommit
            ? "Current authority facts changed."
            : "The local runner has not reported an exact repository base.",
          retry: "REFRESH",
        },
      };
    return {
      ok: true,
      value: {
        projectRevision: project.revision,
        runnerOwnerMemberId: runner.owner_member_id,
        runnerPolicyRevision: runner.policy_revision,
        profileVersion: command.execution.expectedProfileVersion,
        profileFingerprint: profile.fingerprint,
        authorizationSource: exposure ? "TEAM_EXPOSURE" : "OWNER",
        securityPolicyVersion: runner.security_policy_version,
        securityDigest: runner.security_digest,
        resolvedBaseCommit,
        baseBranch: project.base_branch,
        permitSeconds: 30,
        authoritySessionSeconds: 30,
        authorityRenewalSeconds: 10,
        mutationDisconnectGraceSeconds: 15,
        maximumAttempts: configurationBounds.maximum_attempts,
        deadlineAt: clock() + configurationBounds.deadline_seconds,
        connectorEpochs: {},
      },
    };
  };

  const prepareStoredConfiguration = (command: LaunchRun, authority: RefreshedAuthorityFacts) => {
    const actorMemberId =
      command.actor.kind === "MEMBER"
        ? command.actor.memberId
        : command.actor.kind === "SCHEDULER"
          ? command.actor.originalDispatcherId
          : undefined;
    if (!actorMemberId)
      return {
        ok: false as const,
        error: {
          code: "PRESET_BINDING_REQUIRED",
          message: "A member-owned run preset is required.",
          retry: "REFRESH" as const,
        },
      };
    const preset = resolveExactPersonalRunPresetVersion(
      database,
      actorMemberId,
      command.effectiveConfiguration.configurationId,
      command.effectiveConfiguration.version,
    );
    if (
      !preset ||
      preset.derivedTemplate ||
      !preset.contextRecipeId ||
      !preset.contextRecipeVersion
    )
      return {
        ok: false as const,
        error: {
          code: "PRESET_BINDING_REQUIRED",
          message: "The stored run preset is unavailable.",
          retry: "REFRESH" as const,
        },
      };
    const resolved = resolveEffectiveRunConfiguration(preset, {
      runGoal: command.goal,
      authorityFacts: {
        projectRevision: authority.projectRevision,
        runnerPolicyRevision: authority.runnerPolicyRevision,
        securityPolicyVersion: authority.securityPolicyVersion,
        securityDigest: authority.securityDigest as never,
        ...(command.execution.exposureRevision
          ? {
              exposureRevision: command.execution.exposureRevision,
              acknowledgementVersion:
                database
                  .query<{ version: number }, [string, string, number]>(
                    `SELECT acknowledgements.version FROM runner_exposures AS exposures
                     JOIN runner_exposure_acknowledgements AS acknowledgements
                       ON acknowledgements.id = exposures.acknowledgement_id
                     WHERE exposures.runner_id = ? AND exposures.project_id = ?
                       AND exposures.revision = ? AND exposures.revoked_at IS NULL
                       AND acknowledgements.revoked_at IS NULL`,
                  )
                  .get(
                    command.execution.runnerId,
                    command.projectId,
                    command.execution.exposureRevision,
                  )?.version ?? 0,
            }
          : {}),
        connectorEpochs: authority.connectorEpochs,
        grantIds: [],
      },
      currentBinding: {
        projectId: command.projectId,
        runnerId: preset.runnerId,
        runnerEpoch: preset.runnerEpoch,
        mappingRevision: preset.mappingRevision,
        profileId: preset.profileId,
        profileVersion: preset.profileVersion,
        profileFingerprint: preset.profileFingerprint,
      },
    });
    if (!resolved.ok || resolved.value.digest !== command.effectiveConfiguration.digest)
      return resolved.ok
        ? {
            ok: false as const,
            error: {
              code: "RUN_CONFIGURATION_STALE",
              message: "Run configuration changed.",
              retry: "REFRESH" as const,
            },
          }
        : resolved;
    const recipe = database
      .query<{ recipe_digest: string }, [string, number]>(
        "SELECT recipe_digest FROM context_recipe_versions WHERE recipe_id = ? AND version = ?",
      )
      .get(preset.contextRecipeId, preset.contextRecipeVersion);
    if (!recipe)
      return {
        ok: false as const,
        error: {
          code: "CONTEXT_RECIPE_STALE",
          message: "The context recipe changed.",
          retry: "REFRESH" as const,
        },
      };
    return prepareRunConfigurationSnapshot({
      configuration: resolved.value,
      envelope: {
        schemaVersion: 1,
        contextRecipe: {
          id: preset.contextRecipeId,
          version: preset.contextRecipeVersion,
          digest: recipe.recipe_digest as never,
        },
        references: [],
        omissions: [],
      },
    });
  };

  const runnerInfrastructure: ProductionRunnerInfrastructure = {
    runnerKeyProof,
    runnerRequestProof,
    authorityFacts: {
      preview: async (request) => {
        const profile = database
          .query<{ fingerprint: string }, [string, string, number]>(
            "SELECT fingerprint FROM safe_profile_versions WHERE runner_id = ? AND profile_id = ? AND version = ?",
          )
          .get(
            request.execution.runnerId,
            request.execution.profileVersionId,
            request.execution.expectedProfileVersion,
          );
        return profile
          ? {
              ok: true as const,
              value: { refreshedAt: clock(), profileFingerprint: profile.fingerprint },
            }
          : {
              ok: false as const,
              error: {
                code: "AUTHORITY_FACTS_STALE",
                message: "Current authority facts changed.",
                retry: "REFRESH" as const,
              },
            };
      },
      refresh: async (command) => databaseAuthorityFacts(command),
    },
    runConfiguration: {
      resolve: async (command, authority) => prepareStoredConfiguration(command, authority),
    },
    permitCodec,
    defaultSecurityDigest: securityDigest,
    acceptGateEvent: async (body, principal) => {
      const details = JSON.stringify({
        gateEvaluationId: body.gateEvaluationId,
        event: body.event,
        observedAt: body.observedAt,
        runnerId: principal.runnerId,
        runnerEpoch: principal.runnerEpoch,
      });
      return inImmediateTransaction(database, () => {
        const evaluation = database
          .query<{ state: string }, [string]>("SELECT state FROM gate_evaluations WHERE id = ?")
          .get(body.gateEvaluationId);
        if (!evaluation)
          return {
            ok: false as const,
            error: {
              code: "GATE_EVALUATION_NOT_FOUND",
              message: "The gate evaluation was not found.",
              retry: "NEVER" as const,
            },
          };
        const prior = database
          .query<{ safe_details: string }, [string]>(
            "SELECT safe_details FROM audit_events WHERE id = ?",
          )
          .get(body.eventId);
        if (prior)
          return prior.safe_details === details
            ? { ok: true as const, value: { accepted: true as const } }
            : {
                ok: false as const,
                error: {
                  code: "GATE_EVENT_REPLAY",
                  message: "The gate event identifier was replayed.",
                  retry: "NEVER" as const,
                },
              };
        if (body.event === "STARTED" && evaluation.state === "PENDING")
          database
            .query(
              "UPDATE gate_evaluations SET state = 'RUNNING' WHERE id = ? AND state = 'PENDING'",
            )
            .run(body.gateEvaluationId);
        if (body.event === "TERMINATED" && ["PENDING", "RUNNING"].includes(evaluation.state))
          database
            .query(
              "UPDATE gate_evaluations SET state = 'CANCELLED', completed_at = ? WHERE id = ? AND state IN ('PENDING','RUNNING')",
            )
            .run(body.observedAt, body.gateEvaluationId);
        database
          .query(
            "INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, 'GATE_RUNNER_EVENT', 'RUNNER', ?, ?, ?, ?)",
          )
          .run(body.eventId, principal.runnerId, body.gateEvaluationId, details, body.observedAt);
        return { ok: true as const, value: { accepted: true as const } };
      });
    },
  };

  const configuredOrigin = environment.publicBaseUrl;
  const bootstrapSecret = environment.bootstrapSecretFile
    ? readFileSync(environment.bootstrapSecretFile, "utf8").trim()
    : undefined;
  const devices = createDeviceAuthority({ database, clock, id });
  const authentication =
    resources.foundation?.authentication ??
    databaseBrowserAuthentication(database, clock, environment.publicBaseUrl, devices);
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
  const identity = bootstrapSecret
    ? createIdentityAuthority({
        database,
        clock,
        id,
        randomBytes: (length) => new Uint8Array(randomBytes(length)),
        bootstrapSecret,
        publicOrigin: environment.publicBaseUrl,
        rpId: environment.rpId,
        rpName: environment.rpName,
        executionAuthority: authorityDelegate,
      })
    : undefined;
  const draftStore = createWorkflowDraftStore({ database, clock, id });
  const gateCoordinator = createGateCoordinator({ database, clock });
  const planArtifacts = createPlanArtifactStore({ database, clock });
  const managedLoops = createManagedLoopStore(database);
  const workflowUsage = createWorkflowUsageStore({ database, clock });
  const workflows = createWorkflowAuthoringOperations({
    saveDraft: async (command) => draftStore.save(command),
  });
  const templateRegistry = createTemplateRegistry({
    database,
    clock,
    id,
    authority: authorityDelegate,
  });
  const templates: import("./modules/templates/bindings.ts").TemplateBindingOperations = {
    bind: async (command) => {
      const input = command as Record<string, unknown>;
      if (
        typeof input.idempotencyKey !== "string" ||
        typeof input.actorMemberId !== "string" ||
        !input.preset ||
        typeof input.preset !== "object"
      )
        return {
          ok: false,
          error: {
            code: "WORKFLOW_PRESET_INVALID",
            message: "The Personal Workflow Preset is invalid.",
            retry: "NEVER",
          },
        };
      return templateRegistry.bind({
        idempotencyKey: input.idempotencyKey,
        actor: {
          kind: "MEMBER",
          memberId: input.actorMemberId as never,
          sessionId: "workflow_binding" as never,
          sessionProof: "server-authenticated-workflow-binding-proof",
        },
        preset: input.preset as never,
      });
    },
  };
  const workflowEngine = createWorkflowEngine({
    database,
    authority: authorityDelegate,
    clockMs: () => Date.now(),
    resolveLaunches: async ({ definition, inputs, bindings, schedulerActor }) => {
      const launches: Record<
        string,
        import("./modules/workflows/contract.ts").StepLaunchConfiguration
      > = {};
      for (const node of definition.nodes) {
        if (node.kind !== "AGENT_RUN") continue;
        const binding = bindings[node.key];
        const preset = binding
          ? resolveExactPersonalRunPresetVersion(
              database,
              schedulerActor.originalDispatcherId,
              binding.personalRunPresetId,
              binding.expectedVersion,
            )
          : null;
        const template = database
          .query<{ id: string; version: number; definition_json: string }, [string]>(
            "SELECT id, version, definition_json FROM team_run_template_versions WHERE id = ? AND archived_at IS NULL",
          )
          .get(node.runTemplateVersionId);
        if (!binding || !preset?.projectId || !template)
          return {
            ok: false as const,
            error: {
              code: "WORKFLOW_LAUNCH_BINDING_UNAVAILABLE",
              message: "A stored run binding is unavailable.",
              retry: "REFRESH" as const,
            },
          };
        const definitionValue = JSON.parse(
          template.definition_json,
        ) as import("../shared/contracts/templates.ts").TeamRunTemplateDraft;
        const runner = database
          .query<{ owner_member_id: string }, [string]>(
            "SELECT owner_member_id FROM runners WHERE id = ? AND revoked_at IS NULL",
          )
          .get(preset.runnerId);
        const exposureRevision =
          runner && runner.owner_member_id !== schedulerActor.originalDispatcherId
            ? database
                .query<{ revision: number }, [string, string, number, string, number]>(
                  `SELECT revision FROM runner_exposures WHERE runner_id = ? AND project_id = ?
                   AND mapping_revision = ? AND profile_id = ? AND profile_version = ?
                   AND revoked_at IS NULL`,
                )
                .get(
                  preset.runnerId,
                  preset.projectId,
                  preset.mappingRevision,
                  preset.profileId,
                  preset.profileVersion,
                )?.revision
            : undefined;
        const repository = {
          repositoryId: binding.repository.repositoryId as never,
          mode: preset.repositoryMode,
          assurance: preset.repositoryAssurance,
          base: { kind: "RESOLVE_DEFAULT_BASE" as const },
          ...(binding.repository.intendedBranch
            ? { intendedBranch: binding.repository.intendedBranch }
            : {}),
        };
        const execution = {
          runnerId: preset.runnerId as never,
          expectedRunnerEpoch: preset.runnerEpoch,
          projectMappingRevision: preset.mappingRevision,
          profileVersionId: preset.profileId as never,
          expectedProfileVersion: preset.profileVersion,
          ...(exposureRevision ? { exposureRevision } : {}),
          host: preset.host,
          interaction: preset.interaction,
        };
        const goal = preset.reusableGoalTemplate ?? definitionValue.name;
        const provisional = {
          kind: "LAUNCH_RUN" as const,
          idempotencyKey: `workflow_preflight_${node.key}` as never,
          actor: schedulerActor,
          projectId: preset.projectId as never,
          coordination: { kind: "EXISTING", coordinationRecordId: "workflow_preflight" as never },
          goal,
          repository,
          execution,
          effectiveConfiguration: {
            configurationId: preset.presetId,
            version: preset.presetVersion,
            digest: "0".repeat(64) as never,
          },
        } as unknown as LaunchRun;
        const facts = databaseAuthorityFacts(provisional);
        if (!facts.ok) return facts;
        const acknowledgementVersion = exposureRevision
          ? database
              .query<{ version: number }, [string, string, number]>(
                `SELECT acknowledgements.version FROM runner_exposures AS exposures
                 JOIN runner_exposure_acknowledgements AS acknowledgements
                   ON acknowledgements.id = exposures.acknowledgement_id
                 WHERE exposures.runner_id = ? AND exposures.project_id = ?
                   AND exposures.revision = ? AND exposures.revoked_at IS NULL
                   AND acknowledgements.revoked_at IS NULL`,
              )
              .get(preset.runnerId, preset.projectId, exposureRevision)?.version
          : undefined;
        const configuration = resolveEffectiveRunConfiguration(preset, {
          runGoal: goal,
          ...(preset.derivedTemplate?.id === template.id &&
          preset.derivedTemplate.version === template.version
            ? {
                teamTemplate: {
                  id: template.id,
                  version: template.version,
                  coreInstructions: definitionValue.coreInstructions,
                  typedVariables: Object.fromEntries(
                    definitionValue.variables
                      .filter((variable) => inputs[variable.key] !== undefined)
                      .map((variable) => [
                        variable.key,
                        inputs[variable.key] as string | number | boolean,
                      ]),
                  ),
                },
              }
            : {}),
          authorityFacts: {
            projectRevision: facts.value.projectRevision,
            runnerPolicyRevision: facts.value.runnerPolicyRevision,
            securityPolicyVersion: facts.value.securityPolicyVersion,
            securityDigest: facts.value.securityDigest as never,
            ...(exposureRevision && acknowledgementVersion
              ? { exposureRevision, acknowledgementVersion }
              : {}),
            connectorEpochs: facts.value.connectorEpochs,
            grantIds: [],
          },
          currentBinding: {
            projectId: preset.projectId,
            runnerId: preset.runnerId,
            runnerEpoch: preset.runnerEpoch,
            mappingRevision: preset.mappingRevision,
            profileId: preset.profileId,
            profileVersion: preset.profileVersion,
            profileFingerprint: preset.profileFingerprint,
          },
        });
        if (!configuration.ok) return configuration;
        launches[node.key] = {
          projectId: preset.projectId as never,
          goal,
          repository,
          execution,
          effectiveConfiguration: {
            configurationId: preset.presetId,
            version: preset.presetVersion,
            digest: configuration.value.digest,
          },
        };
      }
      return { ok: true as const, value: launches };
    },
    revocationAffects: (snapshot, event) => {
      if (event.kind !== "EXPOSURE") return false;
      const exposure = database
        .query<
          {
            runner_id: string;
            mapping_revision: number;
            profile_id: string;
            profile_version: number;
            revision: number;
          },
          [string]
        >(
          "SELECT runner_id, mapping_revision, profile_id, profile_version, revision FROM runner_exposures WHERE id = ?",
        )
        .get(event.subjectId);
      return Boolean(
        exposure &&
          Object.values(snapshot.launches).some(
            (launch) =>
              launch.execution.runnerId === exposure.runner_id &&
              launch.execution.projectMappingRevision === exposure.mapping_revision &&
              launch.execution.profileVersionId === exposure.profile_id &&
              launch.execution.expectedProfileVersion === exposure.profile_version &&
              launch.execution.exposureRevision === exposure.revision &&
              event.epoch > exposure.revision,
          ),
      );
    },
  });
  const workflowScheduler = createWorkflowScheduler(workflowEngine);
  const workflowOwner = (workflowExecutionId: string, memberId: string): boolean => {
    const row = database
      .query<{ snapshot_json: string }, [string]>(
        "SELECT snapshot_json FROM workflow_executions WHERE id = ?",
      )
      .get(workflowExecutionId);
    if (!row) return true;
    try {
      return JSON.parse(row.snapshot_json).schedulerActor?.originalDispatcherId === memberId;
    } catch {
      return false;
    }
  };
  const notFound = () => ({
    ok: false as const,
    error: {
      code: "WORKFLOW_NOT_FOUND",
      message: "The Workflow Execution was not found.",
      retry: "NEVER" as const,
    },
  });
  const runtime: WorkflowRuntimeOperations = {
    start: (actor, command) =>
      workflowEngine.start({
        ...command,
        schedulerActor: {
          kind: "SCHEDULER",
          originalDispatcherId: actor.memberId,
          workflowExecutionId: command.workflowExecutionId as never,
        },
      }),
    show: async (actor, workflowExecutionId) =>
      workflowOwner(workflowExecutionId, actor.memberId)
        ? workflowEngine.inspect(workflowExecutionId)
        : notFound(),
    pause: (actor, command) => workflowEngine.pause({ ...command, actor }),
    resume: (actor, command) => workflowEngine.resume({ ...command, actor }),
    cancel: (actor, command) => workflowEngine.cancel({ ...command, actor }),
    decide: (actor, command) => workflowEngine.decide({ ...command, actor }),
    event: (actor, command) =>
      workflowOwner(command.workflowExecutionId, actor.memberId)
        ? workflowEngine.accept({
            ...command,
            actor: {
              kind: "SCHEDULER",
              originalDispatcherId: actor.memberId,
              workflowExecutionId: command.workflowExecutionId as never,
            },
          })
        : Promise.resolve(notFound()),
  };
  const automation = resources.automation ?? { workflows, templates, runtime };
  const runs =
    resources.foundation?.runs ??
    createExecutionAuthorityRunOperations({
      authority: authorityDelegate,
      resolveLaunch: async (actor, request) => {
        if (!("projectId" in request))
          return {
            ok: false as const,
            error: {
              code: "RUN_RESUME_CONFIGURATION_REQUIRED",
              message: "Run resume configuration is unavailable.",
              retry: "REFRESH" as const,
            },
          };
        const preset = resolveExactPersonalRunPresetVersion(
          database,
          actor.memberId,
          request.preset.presetId,
          request.preset.presetVersion,
        );
        if (!preset || preset.projectId !== request.projectId || preset.derivedTemplate)
          return {
            ok: false as const,
            error: {
              code: "PRESET_BINDING_REQUIRED",
              message: "The stored run preset is unavailable.",
              retry: "REFRESH" as const,
            },
          };
        const runner = database
          .query<{ owner_member_id: string }, [string]>(
            "SELECT owner_member_id FROM runners WHERE id = ? AND revoked_at IS NULL",
          )
          .get(preset.runnerId);
        const exposureRevision =
          runner && runner.owner_member_id !== actor.memberId
            ? database
                .query<{ revision: number }, [string, string, number, string, number]>(
                  `SELECT revision FROM runner_exposures WHERE runner_id = ? AND project_id = ?
                 AND mapping_revision = ? AND profile_id = ? AND profile_version = ?
                 AND revoked_at IS NULL`,
                )
                .get(
                  preset.runnerId,
                  request.projectId,
                  preset.mappingRevision,
                  preset.profileId,
                  preset.profileVersion,
                )?.revision
            : undefined;
        const repository = {
          repositoryId: request.repository.repositoryId as never,
          mode: preset.repositoryMode,
          assurance: preset.repositoryAssurance,
          base: { kind: "RESOLVE_DEFAULT_BASE" as const },
          ...(request.repository.intendedBranch
            ? { intendedBranch: request.repository.intendedBranch }
            : {}),
        };
        const execution = {
          runnerId: preset.runnerId as never,
          expectedRunnerEpoch: preset.runnerEpoch,
          projectMappingRevision: preset.mappingRevision,
          profileVersionId: preset.profileId as never,
          expectedProfileVersion: preset.profileVersion,
          ...(exposureRevision ? { exposureRevision } : {}),
          host: preset.host,
          interaction: preset.interaction,
        };
        const provisional = {
          kind: "LAUNCH_RUN" as const,
          idempotencyKey: request.idempotencyKey as never,
          actor,
          projectId: request.projectId as never,
          coordination: request.coordination,
          goal: request.goal,
          repository,
          execution,
          effectiveConfiguration: {
            configurationId: preset.presetId,
            version: preset.presetVersion,
            digest: "0".repeat(64) as never,
          },
        } as unknown as LaunchRun;
        const facts = databaseAuthorityFacts(provisional);
        if (!facts.ok) return facts;
        const acknowledgementVersion = exposureRevision
          ? database
              .query<{ version: number }, [string, string, number]>(
                `SELECT acknowledgements.version FROM runner_exposures AS exposures
                 JOIN runner_exposure_acknowledgements AS acknowledgements ON acknowledgements.id = exposures.acknowledgement_id
                 WHERE exposures.runner_id = ? AND exposures.project_id = ? AND exposures.revision = ?
                   AND exposures.revoked_at IS NULL AND acknowledgements.revoked_at IS NULL`,
              )
              .get(preset.runnerId, request.projectId, exposureRevision)?.version
          : undefined;
        const configuration = resolveEffectiveRunConfiguration(preset, {
          runGoal: request.goal,
          authorityFacts: {
            projectRevision: facts.value.projectRevision,
            runnerPolicyRevision: facts.value.runnerPolicyRevision,
            securityPolicyVersion: facts.value.securityPolicyVersion,
            securityDigest: facts.value.securityDigest as never,
            ...(exposureRevision && acknowledgementVersion
              ? { exposureRevision, acknowledgementVersion }
              : {}),
            connectorEpochs: facts.value.connectorEpochs,
            grantIds: [],
          },
          currentBinding: {
            projectId: request.projectId,
            runnerId: preset.runnerId,
            runnerEpoch: preset.runnerEpoch,
            mappingRevision: preset.mappingRevision,
            profileId: preset.profileId,
            profileVersion: preset.profileVersion,
            profileFingerprint: preset.profileFingerprint,
          },
        });
        return configuration.ok
          ? {
              ok: true as const,
              value: {
                repository,
                execution,
                effectiveConfiguration: {
                  configurationId: preset.presetId,
                  version: preset.presetVersion,
                  digest: configuration.value.digest,
                },
              },
            }
          : configuration;
      },
    });
  const connectorAuthority = createConnectorAuthority({
    database,
    clock,
    id,
    digest: async (value) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    attemptAuthority: createConnectorAttemptAuthority(database, clock),
    projectionCodec: (connectorId) => {
      const binding = database
        .query<{ provider: "GITHUB" | "OUTLINE" }, [string]>(
          "SELECT provider FROM connector_provider_bindings WHERE connector_id = ?",
        )
        .get(connectorId);
      if (binding?.provider === "OUTLINE") {
        return createProjectionCodec(OutlineDocumentProjectionSchema) as never;
      }
      return createProjectionCodec(GitHubProjectionSchema) as never;
    },
  });
  const packagedConnectors = createPackagedConnectorResources({
    database,
    clock,
    environment,
    credentials,
    connectorAuthority,
    authentication,
    rateLimits,
    runs,
  });
  const effectiveResources: ServerResources = {
    ...resources,
    github: resources.github ?? packagedConnectors.github,
    outline: resources.outline ?? packagedConnectors.outline,
    inbox: resources.inbox ?? packagedConnectors.inbox,
    startup: async () => {
      await packagedConnectors.startup?.();
      await resources.startup?.();
    },
    shutdown: async () => {
      await resources.shutdown?.();
      await packagedConnectors.shutdown?.();
    },
  };
  let runnerRegistry:
    | Awaited<ReturnType<typeof createProductionServer>>["runnerRegistry"]
    | undefined;
  let runnerAuthentication:
    | Awaited<ReturnType<typeof createProductionServer>>["runnerAuthentication"]
    | undefined;
  const dependencies: FoundationHttpDependencies = {
    configuredOrigin,
    authentication,
    rateLimits,
    runs,
    browserIdentity: effectiveResources.foundation ? undefined : identity,
    deviceIdentity: effectiveResources.foundation ? undefined : devices,
    runnerPairing: effectiveResources.foundation
      ? undefined
      : {
          beginPairing: (command) => {
            if (!runnerRegistry) throw new Error("RUNNER_REGISTRY_UNAVAILABLE");
            return runnerRegistry.beginPairing(command);
          },
          confirmPairing: (command) => {
            if (!runnerRegistry) throw new Error("RUNNER_REGISTRY_UNAVAILABLE");
            return runnerRegistry.confirmPairing(command);
          },
          consumePairing: (command) => {
            if (!runnerRegistry) throw new Error("RUNNER_REGISTRY_UNAVAILABLE");
            return runnerRegistry.consumePairing(command);
          },
        },
    runnerAuthentication: effectiveResources.foundation
      ? undefined
      : {
          exchangeCredential: (command) => {
            if (!runnerAuthentication) throw new Error("RUNNER_AUTHENTICATION_UNAVAILABLE");
            return runnerAuthentication.exchangeCredential(command);
          },
        },
    runnerConfiguration: effectiveResources.foundation
      ? undefined
      : {
          registerMapping: (command) => {
            if (!runnerRegistry) throw new Error("RUNNER_REGISTRY_UNAVAILABLE");
            return runnerRegistry.registerMapping(command);
          },
          replaceMapping: (command) => {
            if (!runnerRegistry) throw new Error("RUNNER_REGISTRY_UNAVAILABLE");
            return runnerRegistry.replaceMapping(command);
          },
          advertiseProfile: (command) => {
            if (!runnerRegistry) throw new Error("RUNNER_REGISTRY_UNAVAILABLE");
            return runnerRegistry.advertiseProfile(command);
          },
        },
    readiness: {
      ready: () =>
        boundAuthority !== undefined &&
        (effectiveResources.foundation !== undefined || identity !== undefined) &&
        automation.workflows !== undefined &&
        automation.templates !== undefined,
    },
    mcp:
      effectiveResources.foundation?.mcp ??
      createMcpHttpHandler({
        authentication,
        rateLimits,
        runs,
        ...(effectiveResources.outline ? { outlineMcp: effectiveResources.outline.mcp } : {}),
        ...(effectiveResources.github?.mcp ? { github: effectiveResources.github.mcp } : {}),
        ...automation,
        workflowRuntime: automation.runtime,
      }),
    ...(effectiveResources.outline ? { outline: effectiveResources.outline } : {}),
  };
  const app = createApp(dependencies, {
    docsRoot: effectiveResources.docsRoot,
    githubWebhooks: effectiveResources.github?.webhooks,
    githubIssues: effectiveResources.github?.issues,
    githubPlanning: effectiveResources.github?.planning,
    inbox: effectiveResources.inbox,
    automation: { authentication, rateLimits, ...automation },
    webRoot: effectiveResources.webRoot,
  });

  const server = await createProductionServer(environment, app, {
    database,
    infrastructure: runnerInfrastructure,
  });
  runnerRegistry = server.runnerRegistry;
  runnerAuthentication = server.runnerAuthentication;
  boundAuthority = server.authority;
  await effectiveResources.startup?.();
  if (!resources.automation) {
    await workflowScheduler.tick();
    workflowScheduler.start();
  }
  let stopped = false;
  return {
    ...server,
    async shutdown() {
      if (stopped) return;
      stopped = true;
      await workflowScheduler.stop();
      await effectiveResources.shutdown?.();
      database.close();
    },
    components: {
      foundation: { state: identity ? ("OPERATIONAL" as const) : ("NOT_CONFIGURED" as const) },
      github: {
        state:
          effectiveResources.github?.state ??
          (effectiveResources.github ? ("OPERATIONAL" as const) : ("DISABLED" as const)),
      },
      outline: {
        state:
          effectiveResources.outline?.state ??
          (effectiveResources.outline ? ("OPERATIONAL" as const) : ("DISABLED" as const)),
      },
      automation: {
        state: "OPERATIONAL" as const,
        engine: workflowEngine,
        scheduler: workflowScheduler,
        gates: gateCoordinator,
        planArtifacts,
        managedLoops,
        usage: workflowUsage,
      },
    },
  };
}

/** Packaged production root; retained legacy name above is an import-compatible seam for tests. */
export const createProductionComposition = createServerDependencies;
