import type { Database } from "bun:sqlite";
import { ServerMessageBodySchema } from "../../../shared/contracts/protocol.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type {
  RunnerControlPort as AuthorityRunnerControlPort,
  DispatchPermitClaims,
  PermitCodec,
} from "../../modules/execution-authority/execution-authority.ts";
import { createConfigurationPersistence } from "../../modules/presets/configuration-resolver.ts";
import type { LiveOutputHub } from "./live-output.ts";
import type { CommittedRunnerOperation, createRunnerChannel } from "./runner-channel.ts";

type Channel = ReturnType<typeof createRunnerChannel>;

type DispatchRow = Readonly<{
  outbox_id: string;
  semantic_digest: string;
  expires_at: number;
  runner_id: string;
  run_id: string;
  attempt_id: string;
  project_id: string;
  repository_id: string;
  run_revision: number;
  attempt_revision: number;
  worktree_identity: string;
  goal: string;
  repository_mode: "MUTATING" | "INSPECT_ONLY";
  repository_assurance: "ADVISORY" | "ENFORCED";
  base_commit: string;
  base_branch: string;
  intended_branch: string | null;
  mapping_revision: number;
  profile_version_id: string;
  profile_fingerprint: string;
  host: "NATIVE" | "ORCA";
  interaction: "HEADLESS" | "INTERACTIVE";
  deadline_at: number;
  envelope_id: string;
  recipe_id: string;
  recipe_version: number;
  recipe_digest: string;
  envelope_digest: string;
  effective_configuration_digest: string;
  assembly_digest: string;
}>;

type ReferenceRow = Readonly<{
  category: string;
  reference_id: string;
  observed_revision: string | null;
  freshness: string;
  omission_reason: string | null;
  preview_text: string | null;
}>;

function failure(code: string, message: string): Result<void> {
  return { ok: false, error: { code, message, retry: "SAME_INPUT" } };
}

export function createDurableRunnerDispatch(
  input: Readonly<{
    database: Database;
    permitCodec: PermitCodec;
    output: LiveOutputHub;
  }>,
) {
  const permits = new Map<string, string>();
  const activeOutputTargets = new Set<string>();
  let channel: Channel | undefined;

  const loadCommitted = (outboxIds: readonly string[]): readonly CommittedRunnerOperation[] => {
    const operations: CommittedRunnerOperation[] = [];
    for (const outboxId of outboxIds) {
      const permit = permits.get(outboxId);
      if (!permit) continue;
      const row = input.database
        .query<DispatchRow, [string]>(
          `SELECT o.id AS outbox_id, o.semantic_digest, o.expires_at, o.runner_id,
                  r.id AS run_id, a.id AS attempt_id, r.project_id, r.repository_id,
                  r.revision AS run_revision, a.revision AS attempt_revision,
                  r.worktree_identity, r.goal, r.repository_mode,
                  r.repository_assurance, r.base_commit, r.base_branch, r.intended_branch,
                  a.mapping_revision,
                  a.profile_version_id, a.profile_fingerprint, a.host, a.interaction,
                  policy.deadline_at, envelope.id AS envelope_id, envelope.recipe_id,
                  envelope.recipe_version, recipe.recipe_digest, envelope.envelope_digest,
                  configuration.effective_configuration_digest, configuration.assembly_digest
           FROM runner_dispatch_outbox o
           JOIN execution_attempts a ON a.id = o.attempt_id
           JOIN agent_runs r ON r.id = a.run_id
           JOIN run_execution_policies policy ON policy.run_id = r.id
           JOIN context_bootstrap_envelopes envelope ON envelope.run_id = r.id
           JOIN run_configuration_snapshots configuration ON configuration.run_id = r.id
           JOIN context_recipe_versions recipe
             ON recipe.recipe_id = envelope.recipe_id AND recipe.version = envelope.recipe_version
           WHERE o.id = ? AND o.status IN ('PENDING', 'DISPATCHED')`,
        )
        .get(outboxId);
      if (!row) continue;
      const configuration = createConfigurationPersistence({
        database: input.database,
        clock: () => 0,
        id: () => "unused",
      }).inspectRunSnapshot(row.run_id);
      if (!configuration.ok) continue;
      const rows = input.database
        .query<ReferenceRow, [string]>(
          `SELECT category, reference_id, observed_revision, freshness,
                  omission_reason, preview_text
           FROM context_envelope_references WHERE envelope_id = ? ORDER BY ordinal`,
        )
        .all(row.envelope_id);
      const references = rows
        .filter((entry) => entry.omission_reason === null)
        .map((entry) => ({
          category: entry.category,
          referenceId: entry.reference_id,
          observedRevision: entry.observed_revision,
          status: entry.freshness,
          ...(entry.preview_text === null ? {} : { authoredPreview: entry.preview_text }),
        }));
      const omissions = rows
        .filter((entry) => entry.omission_reason !== null)
        .map((entry) => ({
          category: entry.category,
          referenceId: entry.reference_id,
          reason: entry.omission_reason,
        }));
      const body = {
        kind: "LAUNCH_ATTEMPT" as const,
        deliveryId: row.outbox_id,
        semanticDigest: row.semantic_digest,
        runId: row.run_id,
        attemptId: row.attempt_id,
        projectId: row.project_id,
        repositoryId: row.repository_id,
        runRevision: row.run_revision,
        attemptRevision: row.attempt_revision,
        worktreeIdentity: row.worktree_identity,
        dispatchPermit: permit,
        goal: row.goal,
        instructions: {
          schemaVersion: 1 as const,
          configurationDigest: row.effective_configuration_digest,
          assemblyDigest: row.assembly_digest,
          contextEnvelopeDigest: row.envelope_digest,
          layers: configuration.value.configuration.layers,
        },
        bootstrap: {
          schemaVersion: 1 as const,
          contextRecipe: {
            id: row.recipe_id,
            version: row.recipe_version,
            digest: row.recipe_digest,
          },
          references,
          omissions,
        },
        projectMappingRevision: row.mapping_revision,
        repositoryMode: row.repository_mode,
        repositoryAssurance: row.repository_assurance,
        baseRevision: row.base_commit,
        baseBranch: row.base_branch,
        ...(row.intended_branch === null ? {} : { intendedBranch: row.intended_branch }),
        host: row.host,
        interaction: row.interaction,
        profileVersionId: row.profile_version_id,
        profileFingerprint: row.profile_fingerprint,
        policyExpiresAt: row.expires_at,
        deadlineAt: row.deadline_at,
      };
      const parsed = ServerMessageBodySchema.safeParse(body);
      if (!parsed.success) continue;
      operations.push({
        outboxId: row.outbox_id,
        runnerId: row.runner_id,
        deliveryId: row.outbox_id,
        semanticDigest: row.semantic_digest,
        expiresAt: row.expires_at,
        body: parsed.data,
      });
      if (row.interaction === "HEADLESS" && !activeOutputTargets.has(row.attempt_id)) {
        input.output.activate("ATTEMPT", row.attempt_id, "HEADLESS");
        activeOutputTargets.add(row.attempt_id);
      }
    }
    return operations;
  };

  const control: AuthorityRunnerControlPort = {
    async dispatch(intent) {
      permits.set(intent.outboxId, intent.permit);
      const receipt = (await channel?.dispatchCommitted([intent.outboxId]))?.[0];
      return receipt?.state === "SOCKET_SENT"
        ? { ok: true, value: undefined }
        : failure("RUNNER_UNREACHABLE", "Runner is unavailable.");
    },
  };

  return {
    control,
    loadCommitted,
    bind(value: Channel): void {
      channel = value;
    },
    async prime(): Promise<void> {
      const pending = input.database
        .query<
          {
            outbox_id: string;
            attempt_id: string;
            snapshot_digest: string;
            issued_at: number;
            expires_at: number;
          },
          []
        >(
          `SELECT o.id AS outbox_id, o.attempt_id, snapshot.snapshot_digest,
                  permit.issued_at, permit.expires_at
           FROM runner_dispatch_outbox o
           JOIN authority_snapshots snapshot ON snapshot.id = o.authority_snapshot_id
           JOIN dispatch_permits permit ON permit.id = o.permit_id
           WHERE o.status IN ('PENDING', 'DISPATCHED') ORDER BY o.created_at, o.id`,
        )
        .all();
      for (const row of pending) {
        const claims: DispatchPermitClaims = {
          kind: "DISPATCH_PERMIT",
          attemptId: row.attempt_id,
          snapshotDigest: row.snapshot_digest,
          issuedAt: row.issued_at,
          expiresAt: row.expires_at,
        };
        permits.set(row.outbox_id, await input.permitCodec.sign(claims));
      }
      if (pending.length > 0 && channel) {
        await channel.dispatchCommitted(pending.map((row) => row.outbox_id));
      }
    },
  };
}
