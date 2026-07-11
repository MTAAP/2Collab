import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  PersonalRunPreset,
  PersonalRunPresetVersion,
  ProjectPersonalPresetDefault,
} from "../../../shared/contracts/presets.ts";
import type { DomainError, Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import { validatePersonalRunPresetVersion } from "./configuration-resolver.ts";

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: string) => string;
}>;

type PresetRow = Readonly<{
  id: string;
  owner_member_id: string;
  project_id: string | null;
  display_name: string;
  state: "ACTIVE" | "ARCHIVED";
  current_version: number;
  revision: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}>;

type VersionRow = Readonly<{
  preset_id: string;
  version: number;
  owner_member_id: string;
  project_id: string | null;
  derived_template_id: string | null;
  derived_template_version: number | null;
  runner_id: string;
  runner_epoch: number;
  mapping_revision: number;
  profile_id: string;
  profile_version: number;
  profile_fingerprint: string;
  adapter: PersonalRunPresetVersion["runtime"];
  host: PersonalRunPresetVersion["host"];
  interaction: PersonalRunPresetVersion["interaction"];
  repository_mode: PersonalRunPresetVersion["repositoryMode"];
  repository_assurance: PersonalRunPresetVersion["repositoryAssurance"];
  execution_policy: PersonalRunPresetVersion["executionPolicy"];
  maximum_attempts: number;
  deadline_seconds: number;
  managed_loop_max_iterations: number | null;
  managed_loop_cadence_seconds: number | null;
  stop_policy_digest: string | null;
  unknown_grace_seconds: number | null;
  unknown_backoff_initial_seconds: number | null;
  unknown_backoff_max_seconds: number | null;
  context_recipe_id: string | null;
  context_recipe_version: number | null;
  reusable_goal_template: string | null;
  reusable_instruction_template: string | null;
  personal_addendum: string | null;
}>;

function error<T>(code: string, message: string, retry: DomainError["retry"] = "NEVER"): Result<T> {
  return { ok: false, error: { code, message, retry } };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function configurationDigest(version: PersonalRunPresetVersion): string {
  return createHash("sha256").update(canonical(version), "utf8").digest("hex");
}

function preset(row: PresetRow): PersonalRunPreset {
  return {
    id: row.id,
    ownerMemberId: row.owner_member_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    displayName: row.display_name,
    state: row.state,
    currentVersion: row.current_version,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
  };
}

function activeMember(database: Database, memberId: string): boolean {
  return Boolean(
    database
      .query<{ present: number }, [string]>(
        "SELECT 1 AS present FROM members WHERE id = ? AND status = 'ACTIVE'",
      )
      .get(memberId),
  );
}

function presetRow(database: Database, presetId: string, ownerMemberId: string): PresetRow | null {
  return (
    database
      .query<PresetRow, [string, string]>(
        `SELECT id, owner_member_id, project_id, display_name, state, current_version,
                revision, created_at, updated_at, archived_at
         FROM personal_run_presets WHERE id = ? AND owner_member_id = ?`,
      )
      .get(presetId, ownerMemberId) ?? null
  );
}

function currentBinding(
  database: Database,
  actorMemberId: string,
  version: PersonalRunPresetVersion,
): Result<never> | undefined {
  if (!version.projectId) {
    const globalBinding = database
      .query<
        {
          owner_member_id: string;
          runner_epoch: number;
          revoked_at: number | null;
          adapter: string;
          fingerprint: string;
          supports_native: number;
          supports_orca: number;
          supports_headless: number;
          supports_interactive: number;
        },
        [string, number, string]
      >(
        `SELECT runners.owner_member_id, runners.runner_epoch, runners.revoked_at,
                profiles.adapter, profiles.fingerprint, profiles.supports_native,
                profiles.supports_orca, profiles.supports_headless,
                profiles.supports_interactive
         FROM runners
         JOIN safe_profile_versions AS profiles ON profiles.runner_id = runners.id
           AND profiles.profile_id = ? AND profiles.version = ?
         WHERE runners.id = ?`,
      )
      .get(version.profileId, version.profileVersion, version.runnerId);
    const supportsHost =
      globalBinding &&
      (version.host === "NATIVE"
        ? globalBinding.supports_native === 1
        : globalBinding.supports_orca === 1);
    const supportsInteraction =
      globalBinding &&
      (version.interaction === "HEADLESS"
        ? globalBinding.supports_headless === 1
        : globalBinding.supports_interactive === 1);
    if (
      !globalBinding ||
      globalBinding.owner_member_id !== actorMemberId ||
      globalBinding.revoked_at !== null ||
      globalBinding.runner_epoch !== version.runnerEpoch ||
      globalBinding.adapter !== version.runtime ||
      globalBinding.fingerprint !== version.profileFingerprint ||
      !supportsHost ||
      !supportsInteraction
    ) {
      return error("PRESET_BINDING_STALE", "The preset execution binding is stale.", "REFRESH");
    }
    return undefined;
  }
  const row = database
    .query<
      {
        owner_member_id: string;
        runner_epoch: number;
        revoked_at: number | null;
        adapter: string;
        fingerprint: string;
        supports_native: number;
        supports_orca: number;
        supports_headless: number;
        supports_interactive: number;
      },
      [string, number, string, number, string]
    >(
      `SELECT runners.owner_member_id, runners.runner_epoch, runners.revoked_at,
              safe_profile_versions.adapter, safe_profile_versions.fingerprint,
              safe_profile_versions.supports_native, safe_profile_versions.supports_orca,
              safe_profile_versions.supports_headless, safe_profile_versions.supports_interactive
       FROM runners
       JOIN runner_mapping_versions ON runner_mapping_versions.runner_id = runners.id
         AND runner_mapping_versions.project_id = ? AND runner_mapping_versions.revision = ?
         AND runner_mapping_versions.revoked_at IS NULL
       JOIN safe_profile_versions ON safe_profile_versions.runner_id = runners.id
         AND safe_profile_versions.profile_id = ? AND safe_profile_versions.version = ?
       WHERE runners.id = ?`,
    )
    .get(
      version.projectId ?? "",
      version.mappingRevision,
      version.profileId,
      version.profileVersion,
      version.runnerId,
    );
  const supportsHost =
    row && (version.host === "NATIVE" ? row.supports_native === 1 : row.supports_orca === 1);
  const supportsInteraction =
    row &&
    (version.interaction === "HEADLESS"
      ? row.supports_headless === 1
      : row.supports_interactive === 1);
  if (
    !row ||
    row.revoked_at !== null ||
    row.runner_epoch !== version.runnerEpoch ||
    row.adapter !== version.runtime ||
    row.fingerprint !== version.profileFingerprint ||
    !supportsHost ||
    !supportsInteraction
  ) {
    return error("PRESET_BINDING_STALE", "The preset execution binding is stale.", "REFRESH");
  }
  if (row.owner_member_id === actorMemberId) return undefined;
  const exposure = database
    .query<{ present: number }, [string, string, number, string, number, string]>(
      `SELECT 1 AS present FROM runner_exposures
       WHERE runner_id = ? AND project_id = ? AND mapping_revision = ? AND profile_id = ?
         AND profile_version = ? AND profile_fingerprint = ? AND revoked_at IS NULL`,
    )
    .get(
      version.runnerId,
      version.projectId ?? "",
      version.mappingRevision,
      version.profileId,
      version.profileVersion,
      version.profileFingerprint,
    );
  return exposure
    ? undefined
    : error("PRESET_BINDING_INELIGIBLE", "The preset execution binding is not eligible.");
}

function currentContextRecipe(
  database: Database,
  version: PersonalRunPresetVersion,
): Result<never> | undefined {
  if (!version.contextRecipeId) return undefined;
  if (!version.projectId) {
    return error("PRESET_CONTEXT_STALE", "The preset context recipe is stale.", "REFRESH");
  }
  const recipe = database
    .query<{ present: number }, [string, string, number]>(
      `SELECT 1 AS present FROM context_recipes AS recipes
       JOIN context_recipe_versions AS versions ON versions.recipe_id = recipes.id
       WHERE recipes.project_id = ? AND recipes.id = ? AND versions.version = ?
         AND recipes.state = 'ACTIVE'`,
    )
    .get(version.projectId, version.contextRecipeId, version.contextRecipeVersion as number);
  return recipe
    ? undefined
    : error("PRESET_CONTEXT_STALE", "The preset context recipe is stale.", "REFRESH");
}

function insertVersion(
  database: Database,
  version: PersonalRunPresetVersion,
  createdAt: number,
): void {
  const loop = version.managedLoop;
  database
    .query<
      void,
      [
        string,
        number,
        string | null,
        number | null,
        string,
        number,
        number,
        string,
        number,
        string,
        PersonalRunPresetVersion["host"],
        PersonalRunPresetVersion["interaction"],
        PersonalRunPresetVersion["repositoryMode"],
        PersonalRunPresetVersion["repositoryAssurance"],
        PersonalRunPresetVersion["executionPolicy"],
        number,
        number,
        number | null,
        number | null,
        string | null,
        number | null,
        number | null,
        number | null,
        string | null,
        number | null,
        string | null,
        string | null,
        string | null,
        string,
        number,
      ]
    >(
      `INSERT INTO personal_run_preset_versions(
         preset_id, version, derived_template_id, derived_template_version, runner_id,
         runner_epoch, mapping_revision, profile_id, profile_version, profile_fingerprint,
         host, interaction, repository_mode, repository_assurance, execution_policy,
         maximum_attempts, deadline_seconds, managed_loop_max_iterations,
         managed_loop_cadence_seconds, stop_policy_digest, unknown_grace_seconds,
         unknown_backoff_initial_seconds, unknown_backoff_max_seconds, context_recipe_id,
         context_recipe_version, reusable_goal_template, reusable_instruction_template,
         personal_addendum, configuration_digest, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      version.presetId,
      version.presetVersion,
      version.derivedTemplate?.id ?? null,
      version.derivedTemplate?.version ?? null,
      version.runnerId,
      version.runnerEpoch,
      version.mappingRevision,
      version.profileId,
      version.profileVersion,
      version.profileFingerprint,
      version.host,
      version.interaction,
      version.repositoryMode,
      version.repositoryAssurance,
      version.executionPolicy,
      version.maximumAttempts,
      version.deadlineSeconds,
      loop?.maximumIterations ?? null,
      loop?.cadenceSeconds ?? null,
      loop?.stopPolicyDigest ?? null,
      loop?.unknownGraceSeconds ?? null,
      loop?.unknownBackoffInitialSeconds ?? null,
      loop?.unknownBackoffMaxSeconds ?? null,
      version.contextRecipeId ?? null,
      version.contextRecipeVersion ?? null,
      version.reusableGoalTemplate ?? null,
      version.reusableInstructionTemplate ?? null,
      version.personalAddendum ?? null,
      configurationDigest(version),
      createdAt,
    );
  [...new Set(version.requiredGates)].sort().forEach((gate, index) => {
    database
      .query<void, [string, number, number, string, string, number]>(
        `INSERT INTO personal_run_preset_gates(
           preset_id, preset_version, ordinal, gate_name, manifest_fingerprint, required
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.presetId,
        version.presetVersion,
        index + 1,
        gate,
        version.gateManifestFingerprint as string,
        1,
      );
  });
}

function versionFromRow(database: Database, row: VersionRow): PersonalRunPresetVersion {
  const storedGates = database
    .query<{ gate_name: string; manifest_fingerprint: string }, [string, number]>(
      `SELECT gate_name, manifest_fingerprint FROM personal_run_preset_gates
       WHERE preset_id = ? AND preset_version = ? AND required = 1 ORDER BY ordinal`,
    )
    .all(row.preset_id, row.version);
  const requiredGates = storedGates.map((gate) => gate.gate_name);
  const gateManifestFingerprint = storedGates[0]?.manifest_fingerprint;
  const hasLoop = row.execution_policy === "MANAGED_LOOP";
  return {
    presetId: row.preset_id,
    presetVersion: row.version,
    ownerMemberId: row.owner_member_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    runtime: row.adapter,
    runnerId: row.runner_id,
    runnerEpoch: row.runner_epoch,
    mappingRevision: row.mapping_revision,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    profileFingerprint: row.profile_fingerprint,
    host: row.host,
    interaction: row.interaction,
    repositoryMode: row.repository_mode,
    repositoryAssurance: row.repository_assurance,
    executionPolicy: row.execution_policy,
    ...(hasLoop
      ? {
          managedLoop: {
            maximumIterations: row.managed_loop_max_iterations as number,
            cadenceSeconds: row.managed_loop_cadence_seconds as number,
            stopPolicyDigest: row.stop_policy_digest as never,
            unknownGraceSeconds: row.unknown_grace_seconds as number,
            unknownBackoffInitialSeconds: row.unknown_backoff_initial_seconds as number,
            unknownBackoffMaxSeconds: row.unknown_backoff_max_seconds as number,
          },
        }
      : {}),
    maximumAttempts: row.maximum_attempts,
    deadlineSeconds: row.deadline_seconds,
    ...(row.derived_template_id
      ? {
          derivedTemplate: {
            id: row.derived_template_id,
            version: row.derived_template_version as number,
          },
        }
      : {}),
    ...(row.context_recipe_id ? { contextRecipeId: row.context_recipe_id } : {}),
    ...(row.context_recipe_version ? { contextRecipeVersion: row.context_recipe_version } : {}),
    requiredGates,
    ...(gateManifestFingerprint
      ? { gateManifestFingerprint: gateManifestFingerprint as never }
      : {}),
    ...(row.reusable_goal_template ? { reusableGoalTemplate: row.reusable_goal_template } : {}),
    ...(row.reusable_instruction_template
      ? { reusableInstructionTemplate: row.reusable_instruction_template }
      : {}),
    ...(row.personal_addendum ? { personalAddendum: row.personal_addendum } : {}),
  };
}

function readVersion(
  database: Database,
  presetId: string,
  ownerMemberId: string,
  version: number,
): PersonalRunPresetVersion | null {
  const row = database
    .query<VersionRow, [string, string, number]>(
      `SELECT versions.preset_id, versions.version, presets.owner_member_id, presets.project_id,
              versions.derived_template_id, versions.derived_template_version, versions.runner_id,
              versions.runner_epoch, versions.mapping_revision, versions.profile_id,
              versions.profile_version, versions.profile_fingerprint, profiles.adapter,
              versions.host, versions.interaction, versions.repository_mode,
              versions.repository_assurance, versions.execution_policy, versions.maximum_attempts,
              versions.deadline_seconds, versions.managed_loop_max_iterations,
              versions.managed_loop_cadence_seconds, versions.stop_policy_digest,
              versions.unknown_grace_seconds, versions.unknown_backoff_initial_seconds,
              versions.unknown_backoff_max_seconds, versions.context_recipe_id,
              versions.context_recipe_version, versions.reusable_goal_template,
              versions.reusable_instruction_template, versions.personal_addendum
       FROM personal_run_preset_versions AS versions
       JOIN personal_run_presets AS presets ON presets.id = versions.preset_id
       JOIN safe_profile_versions AS profiles ON profiles.runner_id = versions.runner_id
         AND profiles.profile_id = versions.profile_id AND profiles.version = versions.profile_version
         AND profiles.fingerprint = versions.profile_fingerprint
       WHERE versions.preset_id = ? AND presets.owner_member_id = ? AND versions.version = ?`,
    )
    .get(presetId, ownerMemberId, version);
  return row ? versionFromRow(database, row) : null;
}

export function createPersonalRunPresetStore(dependencies: Dependencies) {
  const inspectVersion = (
    actorMemberId: string,
    presetId: string,
    version: number,
  ): Result<PersonalRunPresetVersion> => {
    if (!activeMember(dependencies.database, actorMemberId)) {
      return error("MEMBER_AUTHORITY_REQUIRED", "Active member authority is required.");
    }
    const value = readVersion(dependencies.database, presetId, actorMemberId, version);
    return value ? { ok: true, value } : error("PRESET_NOT_FOUND", "Run preset was not found.");
  };

  return {
    async create(
      input: Readonly<{
        actorMemberId: string;
        displayName: string;
        version: PersonalRunPresetVersion;
      }>,
    ): Promise<Result<PersonalRunPreset & Readonly<{ version: PersonalRunPresetVersion }>>> {
      if (!activeMember(dependencies.database, input.actorMemberId)) {
        return error("MEMBER_AUTHORITY_REQUIRED", "Active member authority is required.");
      }
      if (input.version.ownerMemberId !== input.actorMemberId) {
        return error("PRESET_OWNER_REQUIRED", "Only the preset owner may change this preset.");
      }
      if (
        input.displayName.trim() !== input.displayName ||
        input.displayName.length === 0 ||
        input.displayName.length > 120 ||
        input.version.presetVersion !== 1
      ) {
        return error("PRESET_INVALID", "The run preset is invalid.");
      }
      const validation = validatePersonalRunPresetVersion(input.version);
      if (!validation.ok) return validation;
      const stale = currentBinding(dependencies.database, input.actorMemberId, input.version);
      if (stale) return stale;
      const staleContext = currentContextRecipe(dependencies.database, input.version);
      if (staleContext) return staleContext;
      try {
        return inImmediateTransaction(dependencies.database, () => {
          if (presetRow(dependencies.database, input.version.presetId, input.actorMemberId)) {
            return error("PRESET_ALREADY_EXISTS", "Run preset already exists.");
          }
          const now = dependencies.clock();
          dependencies.database
            .query<
              void,
              [string, string, string | null, string, string, number, number, number, number]
            >(
              `INSERT INTO personal_run_presets(
                 id, owner_member_id, project_id, display_name, state, current_version,
                 revision, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.version.presetId,
              input.actorMemberId,
              input.version.projectId ?? null,
              input.displayName,
              "ACTIVE",
              1,
              1,
              now,
              now,
            );
          insertVersion(dependencies.database, input.version, now);
          dependencies.database
            .query<void, [string, string, string, string, string, string, number]>(
              `INSERT INTO audit_events(
                 id, kind, actor_kind, actor_id, subject_id, safe_details, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              dependencies.id("audit"),
              "PERSONAL_RUN_PRESET_CREATED",
              "MEMBER",
              input.actorMemberId,
              input.version.presetId,
              JSON.stringify({ projectId: input.version.projectId ?? null, version: 1 }),
              now,
            );
          const row = presetRow(
            dependencies.database,
            input.version.presetId,
            input.actorMemberId,
          ) as PresetRow;
          return { ok: true as const, value: { ...preset(row), version: input.version } };
        });
      } catch {
        return error("PRESET_STORAGE_FAILED", "Run preset could not be stored.", "SAME_INPUT");
      }
    },

    async edit(
      input: Readonly<{
        actorMemberId: string;
        presetId: string;
        expectedRevision: number;
        version: PersonalRunPresetVersion;
      }>,
    ): Promise<Result<PersonalRunPreset & Readonly<{ version: PersonalRunPresetVersion }>>> {
      if (!activeMember(dependencies.database, input.actorMemberId)) {
        return error("MEMBER_AUTHORITY_REQUIRED", "Active member authority is required.");
      }
      const current = presetRow(dependencies.database, input.presetId, input.actorMemberId);
      if (!current) return error("PRESET_NOT_FOUND", "Run preset was not found.");
      if (current.state === "ARCHIVED") return error("PRESET_ARCHIVED", "Run preset is archived.");
      if (current.revision !== input.expectedRevision) {
        return error("PRESET_REVISION_CONFLICT", "Run preset revision changed.", "REFRESH");
      }
      if (
        input.version.presetId !== current.id ||
        input.version.ownerMemberId !== current.owner_member_id ||
        (input.version.projectId ?? null) !== current.project_id ||
        input.version.presetVersion !== current.current_version + 1
      ) {
        return error("PRESET_INVALID", "The run preset is invalid.");
      }
      const validation = validatePersonalRunPresetVersion(input.version);
      if (!validation.ok) return validation;
      const stale = currentBinding(dependencies.database, input.actorMemberId, input.version);
      if (stale) return stale;
      const staleContext = currentContextRecipe(dependencies.database, input.version);
      if (staleContext) return staleContext;
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const committed = presetRow(dependencies.database, input.presetId, input.actorMemberId);
          if (committed?.state !== "ACTIVE") {
            return error("PRESET_NOT_FOUND", "Run preset was not found.");
          }
          if (committed.revision !== input.expectedRevision) {
            return error("PRESET_REVISION_CONFLICT", "Run preset revision changed.", "REFRESH");
          }
          const now = dependencies.clock();
          insertVersion(dependencies.database, input.version, now);
          dependencies.database
            .query<void, [number, number, number, string, number]>(
              `UPDATE personal_run_presets
               SET current_version = ?, revision = ?, updated_at = ?
               WHERE id = ? AND revision = ?`,
            )
            .run(
              input.version.presetVersion,
              committed.revision + 1,
              now,
              input.presetId,
              committed.revision,
            );
          const updated = presetRow(
            dependencies.database,
            input.presetId,
            input.actorMemberId,
          ) as PresetRow;
          return { ok: true as const, value: { ...preset(updated), version: input.version } };
        });
      } catch {
        return error("PRESET_STORAGE_FAILED", "Run preset could not be stored.", "SAME_INPUT");
      }
    },

    archive(
      input: Readonly<{
        actorMemberId: string;
        presetId: string;
        expectedRevision: number;
      }>,
    ): Result<PersonalRunPreset> {
      if (!activeMember(dependencies.database, input.actorMemberId)) {
        return error("MEMBER_AUTHORITY_REQUIRED", "Active member authority is required.");
      }
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const current = presetRow(dependencies.database, input.presetId, input.actorMemberId);
          if (!current) return error("PRESET_NOT_FOUND", "Run preset was not found.");
          if (current.revision !== input.expectedRevision) {
            return error("PRESET_REVISION_CONFLICT", "Run preset revision changed.", "REFRESH");
          }
          if (current.state === "ARCHIVED") return { ok: true as const, value: preset(current) };
          const now = dependencies.clock();
          dependencies.database
            .query<void, [string, number, number, number, string, number]>(
              `UPDATE personal_run_presets
               SET state = ?, revision = ?, updated_at = ?, archived_at = ?
               WHERE id = ? AND revision = ?`,
            )
            .run("ARCHIVED", current.revision + 1, now, now, current.id, current.revision);
          const updated = presetRow(
            dependencies.database,
            input.presetId,
            input.actorMemberId,
          ) as PresetRow;
          return { ok: true as const, value: preset(updated) };
        });
      } catch {
        return error("PRESET_STORAGE_FAILED", "Run preset could not be archived.", "SAME_INPUT");
      }
    },

    setProjectDefault(
      input: Readonly<{
        actorMemberId: string;
        projectId: string;
        presetId: string;
        presetVersion: number;
        expectedRevision: number;
      }>,
    ): Result<ProjectPersonalPresetDefault> {
      if (!activeMember(dependencies.database, input.actorMemberId)) {
        return error("MEMBER_AUTHORITY_REQUIRED", "Active member authority is required.");
      }
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const selected = presetRow(dependencies.database, input.presetId, input.actorMemberId);
          if (!selected || selected.project_id !== input.projectId) {
            return error("PRESET_NOT_FOUND", "Run preset was not found.");
          }
          if (selected.state === "ARCHIVED") {
            return error("PRESET_ARCHIVED", "Run preset is archived.");
          }
          if (
            !readVersion(
              dependencies.database,
              input.presetId,
              input.actorMemberId,
              input.presetVersion,
            )
          ) {
            return error("PRESET_VERSION_NOT_FOUND", "Run preset version was not found.");
          }
          const prior = dependencies.database
            .query<{ revision: number }, [string, string]>(
              `SELECT revision FROM project_personal_preset_defaults
               WHERE owner_member_id = ? AND project_id = ?`,
            )
            .get(input.actorMemberId, input.projectId);
          const priorRevision = prior?.revision ?? 0;
          if (priorRevision !== input.expectedRevision) {
            return error("PRESET_DEFAULT_REVISION_CONFLICT", "Preset default changed.", "REFRESH");
          }
          const revision = priorRevision + 1;
          const now = dependencies.clock();
          dependencies.database
            .query<void, [string, string, string, number, number, number]>(
              `INSERT INTO project_personal_preset_defaults(
                 owner_member_id, project_id, preset_id, preset_version, revision, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(owner_member_id, project_id) DO UPDATE SET
                 preset_id = excluded.preset_id,
                 preset_version = excluded.preset_version,
                 revision = excluded.revision,
                 updated_at = excluded.updated_at`,
            )
            .run(
              input.actorMemberId,
              input.projectId,
              input.presetId,
              input.presetVersion,
              revision,
              now,
            );
          return {
            ok: true as const,
            value: {
              ownerMemberId: input.actorMemberId,
              projectId: input.projectId,
              presetId: input.presetId,
              presetVersion: input.presetVersion,
              revision,
              updatedAt: now,
            },
          };
        });
      } catch {
        return error("PRESET_STORAGE_FAILED", "Preset default could not be stored.", "SAME_INPUT");
      }
    },

    projectDefault(
      actorMemberId: string,
      projectId: string,
    ): Result<ProjectPersonalPresetDefault & Readonly<{ version: PersonalRunPresetVersion }>> {
      if (!activeMember(dependencies.database, actorMemberId)) {
        return error("MEMBER_AUTHORITY_REQUIRED", "Active member authority is required.");
      }
      const row = dependencies.database
        .query<
          {
            preset_id: string;
            preset_version: number;
            revision: number;
            updated_at: number;
            state: "ACTIVE" | "ARCHIVED";
          },
          [string, string]
        >(
          `SELECT defaults.preset_id, defaults.preset_version, defaults.revision,
                  defaults.updated_at, presets.state
           FROM project_personal_preset_defaults AS defaults
           JOIN personal_run_presets AS presets ON presets.id = defaults.preset_id
           WHERE defaults.owner_member_id = ? AND defaults.project_id = ?`,
        )
        .get(actorMemberId, projectId);
      if (!row) return error("PRESET_DEFAULT_NOT_FOUND", "Preset default was not found.");
      if (row.state !== "ACTIVE") {
        return error("PRESET_DEFAULT_STALE", "Preset default is stale.", "REFRESH");
      }
      const version = readVersion(
        dependencies.database,
        row.preset_id,
        actorMemberId,
        row.preset_version,
      );
      if (!version) return error("PRESET_DEFAULT_STALE", "Preset default is stale.", "REFRESH");
      const staleBinding = currentBinding(dependencies.database, actorMemberId, version);
      const staleContext = currentContextRecipe(dependencies.database, version);
      if (staleBinding || staleContext) {
        return error("PRESET_DEFAULT_STALE", "Preset default is stale.", "REFRESH");
      }
      return {
        ok: true,
        value: {
          ownerMemberId: actorMemberId,
          projectId,
          presetId: row.preset_id,
          presetVersion: row.preset_version,
          revision: row.revision,
          updatedAt: row.updated_at,
          version,
        },
      };
    },

    inspectVersion,

    list(actorMemberId: string): readonly PersonalRunPreset[] {
      if (!activeMember(dependencies.database, actorMemberId)) return [];
      return dependencies.database
        .query<PresetRow, [string]>(
          `SELECT id, owner_member_id, project_id, display_name, state, current_version,
                  revision, created_at, updated_at, archived_at
           FROM personal_run_presets WHERE owner_member_id = ? ORDER BY updated_at DESC, id`,
        )
        .all(actorMemberId)
        .map(preset);
    },
  };
}
