import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { ReferenceFirstBootstrapEnvelope } from "../../../shared/contracts/context.ts";
import type {
  EffectiveRunConfiguration,
  PersonalRunPresetVersion,
  RepositoryMode,
} from "../../../shared/contracts/presets.ts";
import type { DomainError, Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";

const allowedKeys = new Set([
  "presetId",
  "presetVersion",
  "ownerMemberId",
  "projectId",
  "runtime",
  "runnerId",
  "runnerEpoch",
  "mappingRevision",
  "profileId",
  "profileVersion",
  "profileFingerprint",
  "host",
  "interaction",
  "repositoryMode",
  "repositoryAssurance",
  "executionPolicy",
  "managedLoop",
  "maximumAttempts",
  "deadlineSeconds",
  "derivedTemplate",
  "contextRecipeId",
  "contextRecipeVersion",
  "requiredGates",
  "gateManifestFingerprint",
  "reusableGoalTemplate",
  "reusableInstructionTemplate",
  "personalAddendum",
]);

function error(
  code: string,
  message: string,
  retry: DomainError["retry"] = "NEVER",
): Result<never> {
  return { ok: false, error: { code, message, retry } };
}

export function validatePersonalRunPresetVersion(
  value: PersonalRunPresetVersion,
): Result<PersonalRunPresetVersion> {
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return error(
      "PRESET_PRIVATE_CONFIGURATION",
      "Run presets cannot contain runner-local configuration.",
    );
  }
  const identifiers = [
    value.presetId,
    value.ownerMemberId,
    value.runnerId,
    value.profileId,
    ...(value.projectId ? [value.projectId] : []),
    ...(value.contextRecipeId ? [value.contextRecipeId] : []),
  ];
  if (
    identifiers.some((identifier) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(identifier)) ||
    !["CLAUDE", "CODEX", "PI", "OPENCODE"].includes(value.runtime) ||
    !["NATIVE", "ORCA"].includes(value.host) ||
    !["HEADLESS", "INTERACTIVE"].includes(value.interaction) ||
    !["INSPECT_ONLY", "MUTATING"].includes(value.repositoryMode) ||
    !["ADVISORY", "ENFORCED"].includes(value.repositoryAssurance) ||
    !["ONCE", "MANAGED_LOOP"].includes(value.executionPolicy) ||
    !Number.isInteger(value.presetVersion) ||
    value.presetVersion <= 0 ||
    !Number.isInteger(value.runnerEpoch) ||
    value.runnerEpoch <= 0 ||
    !Number.isInteger(value.mappingRevision) ||
    value.mappingRevision <= 0 ||
    !Number.isInteger(value.profileVersion) ||
    value.profileVersion <= 0 ||
    !/^[a-f0-9]{64}$/.test(value.profileFingerprint) ||
    !Number.isInteger(value.maximumAttempts) ||
    value.maximumAttempts <= 0 ||
    value.maximumAttempts > 1_000 ||
    !Number.isInteger(value.deadlineSeconds) ||
    value.deadlineSeconds <= 0 ||
    value.deadlineSeconds > 2_592_000 ||
    value.requiredGates.length > 64 ||
    value.requiredGates.some((gate) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(gate)) ||
    value.requiredGates.length > 0 !== (value.gateManifestFingerprint !== undefined) ||
    (value.gateManifestFingerprint !== undefined &&
      !/^[a-f0-9]{64}$/.test(value.gateManifestFingerprint)) ||
    (value.reusableGoalTemplate?.length ?? 0) > 16_384 ||
    (value.reusableInstructionTemplate?.length ?? 0) > 16_384 ||
    (value.personalAddendum?.length ?? 0) > 16_384 ||
    (value.derivedTemplate !== undefined &&
      (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.derivedTemplate.id) ||
        !Number.isInteger(value.derivedTemplate.version) ||
        value.derivedTemplate.version <= 0)) ||
    (value.contextRecipeId === undefined) !== (value.contextRecipeVersion === undefined) ||
    (value.contextRecipeVersion !== undefined &&
      (!Number.isInteger(value.contextRecipeVersion) || value.contextRecipeVersion <= 0)) ||
    (value.executionPolicy === "ONCE" && value.managedLoop !== undefined) ||
    (value.executionPolicy === "MANAGED_LOOP" &&
      (!value.managedLoop ||
        !Number.isInteger(value.managedLoop.maximumIterations) ||
        value.managedLoop.maximumIterations <= 0 ||
        value.managedLoop.maximumIterations > value.maximumAttempts ||
        !Number.isInteger(value.managedLoop.cadenceSeconds) ||
        value.managedLoop.cadenceSeconds <= 0 ||
        !/^[a-f0-9]{64}$/.test(value.managedLoop.stopPolicyDigest) ||
        !Number.isInteger(value.managedLoop.unknownGraceSeconds) ||
        value.managedLoop.unknownGraceSeconds <= 0 ||
        !Number.isInteger(value.managedLoop.unknownBackoffInitialSeconds) ||
        value.managedLoop.unknownBackoffInitialSeconds <= 0 ||
        !Number.isInteger(value.managedLoop.unknownBackoffMaxSeconds) ||
        value.managedLoop.unknownBackoffMaxSeconds <
          value.managedLoop.unknownBackoffInitialSeconds))
  ) {
    return error("PRESET_INVALID", "The run preset is invalid.");
  }
  return { ok: true, value };
}

export type ConfigurationOverrides = Readonly<{
  repositoryMode?: RepositoryMode;
  repositoryAssurance?: "ADVISORY" | "ENFORCED";
  maximumAttempts?: number;
  deadlineSeconds?: number;
  requiredGates?: readonly string[];
  runGoal: string;
  authoredRunInput?: string;
  teamTemplate?: Readonly<{
    id: string;
    version: number;
    coreInstructions: string;
    typedVariables: Readonly<Record<string, string | number | boolean>>;
  }>;
  authorityFacts?: EffectiveRunConfiguration["provenance"]["authority"];
  currentBinding?: Readonly<{
    projectId: string;
    runnerId: string;
    runnerEpoch: number;
    mappingRevision: number;
    profileId: string;
    profileVersion: number;
    profileFingerprint: string;
  }>;
}>;

function validTypedVariables(
  variables: Readonly<Record<string, string | number | boolean>>,
): boolean {
  const entries = Object.entries(variables);
  return (
    entries.length <= 64 &&
    entries.every(
      ([key, value]) =>
        /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) &&
        (typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)) ||
          (typeof value === "string" && value.length <= 2_048)),
    )
  );
}

function validAuthorityFacts(
  value: NonNullable<ConfigurationOverrides["authorityFacts"]>,
): boolean {
  return (
    Number.isInteger(value.projectRevision) &&
    value.projectRevision > 0 &&
    Number.isInteger(value.runnerPolicyRevision) &&
    value.runnerPolicyRevision > 0 &&
    Number.isInteger(value.securityPolicyVersion) &&
    value.securityPolicyVersion > 0 &&
    /^[a-f0-9]{64}$/.test(value.securityDigest) &&
    (value.exposureRevision === undefined ||
      (Number.isInteger(value.exposureRevision) && value.exposureRevision > 0)) &&
    (value.acknowledgementVersion === undefined ||
      (Number.isInteger(value.acknowledgementVersion) && value.acknowledgementVersion > 0)) &&
    Object.keys(value.connectorEpochs).length <= 64 &&
    Object.entries(value.connectorEpochs).every(
      ([id, epoch]) =>
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) && Number.isInteger(epoch) && epoch > 0,
    ) &&
    value.grantIds.length <= 64 &&
    (value.exposureRevision === undefined) === (value.acknowledgementVersion === undefined) &&
    value.grantIds.every((id) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
  );
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

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export function resolveEffectiveRunConfiguration(
  preset: PersonalRunPresetVersion,
  overrides: ConfigurationOverrides,
): Result<EffectiveRunConfiguration> {
  const valid = validatePersonalRunPresetVersion(preset);
  if (!valid.ok) return valid;
  const teamTemplate = overrides.teamTemplate;
  if (
    preset.derivedTemplate &&
    (!teamTemplate ||
      teamTemplate.id !== preset.derivedTemplate.id ||
      teamTemplate.version !== preset.derivedTemplate.version)
  ) {
    return error("PRESET_TEMPLATE_STALE", "The preset team template binding is stale.");
  }
  if (
    (!preset.derivedTemplate && teamTemplate !== undefined) ||
    (teamTemplate !== undefined &&
      (teamTemplate.coreInstructions.length === 0 ||
        teamTemplate.coreInstructions.length > 16_384 ||
        !validTypedVariables(teamTemplate.typedVariables))) ||
    (overrides.authoredRunInput?.length ?? 0) > 16_384 ||
    (overrides.authorityFacts !== undefined && !validAuthorityFacts(overrides.authorityFacts))
  ) {
    return error("CONFIGURATION_INVALID", "The requested run configuration is invalid.");
  }
  const current = overrides.currentBinding;
  if (!current || !overrides.authorityFacts) {
    return error(
      "PRESET_BINDING_REQUIRED",
      "Current execution binding and authority facts are required.",
      "REFRESH",
    );
  }
  if (
    (preset.projectId !== undefined && current.projectId !== preset.projectId) ||
    current.runnerId !== preset.runnerId ||
    current.runnerEpoch !== preset.runnerEpoch ||
    current.mappingRevision !== preset.mappingRevision ||
    current.profileId !== preset.profileId ||
    current.profileVersion !== preset.profileVersion ||
    current.profileFingerprint !== preset.profileFingerprint
  ) {
    return error("PRESET_BINDING_STALE", "The preset execution binding is stale.");
  }
  const gates = [...new Set(overrides.requiredGates ?? preset.requiredGates)].sort();
  const missingRequiredGate = preset.requiredGates.some((gate) => !gates.includes(gate));
  const repositoryMode = overrides.repositoryMode ?? preset.repositoryMode;
  const widensRepository =
    preset.repositoryMode === "INSPECT_ONLY" && repositoryMode === "MUTATING";
  const maximumAttempts = overrides.maximumAttempts ?? preset.maximumAttempts;
  const deadlineSeconds = overrides.deadlineSeconds ?? preset.deadlineSeconds;
  if (
    overrides.runGoal.length === 0 ||
    overrides.runGoal.length > 16_384 ||
    !Number.isInteger(maximumAttempts) ||
    !Number.isInteger(deadlineSeconds) ||
    gates.length > 64 ||
    gates.some((gate) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(gate))
  ) {
    return error("CONFIGURATION_INVALID", "The requested run configuration is invalid.");
  }
  if (
    widensRepository ||
    (overrides.repositoryAssurance !== undefined &&
      overrides.repositoryAssurance !== preset.repositoryAssurance) ||
    maximumAttempts > preset.maximumAttempts ||
    deadlineSeconds > preset.deadlineSeconds ||
    maximumAttempts <= 0 ||
    deadlineSeconds <= 0 ||
    missingRequiredGate
  ) {
    return error(
      "CONFIGURATION_WIDENING_DENIED",
      "The requested run configuration exceeds the preset authority.",
    );
  }
  const layers = {
    ...(teamTemplate ? { teamCore: teamTemplate.coreInstructions } : {}),
    typedVariables: teamTemplate?.typedVariables ?? {},
    ...(preset.personalAddendum ? { personalAddendum: preset.personalAddendum } : {}),
    runGoal: overrides.runGoal,
    ...(overrides.authoredRunInput ? { authoredRunInput: overrides.authoredRunInput } : {}),
  };
  const provenance: EffectiveRunConfiguration["provenance"] = {
    preset: { id: preset.presetId, version: preset.presetVersion },
    ...(teamTemplate
      ? { teamTemplate: { id: teamTemplate.id, version: teamTemplate.version } }
      : {}),
    ...(preset.contextRecipeId
      ? {
          contextRecipe: {
            id: preset.contextRecipeId,
            version: preset.contextRecipeVersion as number,
          },
        }
      : {}),
    binding: {
      runnerId: preset.runnerId,
      runnerEpoch: preset.runnerEpoch,
      mappingRevision: preset.mappingRevision,
      profileId: preset.profileId,
      profileVersion: preset.profileVersion,
      profileFingerprint: preset.profileFingerprint,
    },
    ...(overrides.authorityFacts ? { authority: overrides.authorityFacts } : {}),
  };
  const visibleOverrides: EffectiveRunConfiguration["visibleOverrides"] = {
    ...(repositoryMode !== preset.repositoryMode ? { repositoryMode } : {}),
    ...(overrides.repositoryAssurance !== undefined
      ? { repositoryAssurance: overrides.repositoryAssurance }
      : {}),
    ...(maximumAttempts !== preset.maximumAttempts ? { maximumAttempts } : {}),
    ...(deadlineSeconds !== preset.deadlineSeconds ? { deadlineSeconds } : {}),
    ...(overrides.requiredGates !== undefined ? { requiredGates: gates } : {}),
  };
  const configuration = {
    ...preset,
    projectId: current.projectId,
    repositoryMode,
    maximumAttempts,
    deadlineSeconds,
    requiredGates: gates,
    layers,
    provenance,
    visibleOverrides,
  };
  const digest = sha256(configuration);
  return { ok: true, value: { ...configuration, digest: digest as never } };
}

function validEffectiveConfiguration(value: EffectiveRunConfiguration): boolean {
  const { digest, layers, provenance, visibleOverrides, ...preset } = value;
  const validation = validatePersonalRunPresetVersion(preset);
  return (
    validation.ok &&
    /^[a-f0-9]{64}$/.test(digest) &&
    sha256({ ...preset, layers, provenance, visibleOverrides }) === digest &&
    layers.runGoal.length > 0 &&
    layers.runGoal.length <= 16_384 &&
    (layers.teamCore?.length ?? 0) <= 16_384 &&
    validTypedVariables(layers.typedVariables) &&
    (layers.personalAddendum?.length ?? 0) <= 16_384 &&
    (layers.authoredRunInput?.length ?? 0) <= 16_384 &&
    layers.personalAddendum === preset.personalAddendum &&
    provenance.preset.id === preset.presetId &&
    provenance.preset.version === preset.presetVersion &&
    provenance.binding.runnerId === preset.runnerId &&
    provenance.binding.runnerEpoch === preset.runnerEpoch &&
    provenance.binding.mappingRevision === preset.mappingRevision &&
    provenance.binding.profileId === preset.profileId &&
    provenance.binding.profileVersion === preset.profileVersion &&
    provenance.binding.profileFingerprint === preset.profileFingerprint &&
    (provenance.authority === undefined || validAuthorityFacts(provenance.authority))
  );
}

export type ConfigurationSnapshot = Readonly<{
  runId: string;
  configuration: EffectiveRunConfiguration;
  envelope: ReferenceFirstBootstrapEnvelope;
  authoredRunInput?: string;
  createdAt: number;
}>;

type PreparedReferenceRow = Readonly<{
  category: string;
  referenceId: string;
  observedRevision: string | null;
  freshness: "FRESH" | "STALE" | "UNAVAILABLE" | "FORBIDDEN";
  omissionReason: string | null;
  previewText: string | null;
}>;

export type PreparedRunConfigurationSnapshot = Readonly<{
  configuration: EffectiveRunConfiguration;
  envelope: ReferenceFirstBootstrapEnvelope;
  authoredRunInput?: string;
  configurationJson: string;
  previewBytes: number;
  envelopeDigest: string;
  assemblyDigest: string;
  referenceRows: readonly PreparedReferenceRow[];
}>;

export function prepareRunConfigurationSnapshot(
  input: Readonly<{
    configuration: EffectiveRunConfiguration;
    envelope: ReferenceFirstBootstrapEnvelope;
    authoredRunInput?: string;
  }>,
): Result<PreparedRunConfigurationSnapshot> {
  if (
    !validEffectiveConfiguration(input.configuration) ||
    input.configuration.provenance.authority === undefined ||
    input.envelope.contextRecipe.id !== input.configuration.contextRecipeId ||
    input.envelope.contextRecipe.version !== input.configuration.contextRecipeVersion ||
    input.envelope.references.length > 64 ||
    input.envelope.omissions.length > 4_096 ||
    (input.authoredRunInput?.length ?? 0) > 16_384 ||
    input.authoredRunInput !== input.configuration.layers.authoredRunInput
  ) {
    return error("RUN_CONFIGURATION_INVALID", "Run configuration is invalid.");
  }
  const configurationJson = canonical(input.configuration);
  if (Buffer.byteLength(configurationJson, "utf8") > 65_536) {
    return error("RUN_CONFIGURATION_INVALID", "Run configuration is invalid.");
  }
  const referenceRows: PreparedReferenceRow[] = [
    ...input.envelope.references.map((reference) => ({
      category: reference.category,
      referenceId: reference.referenceId,
      observedRevision: reference.observedRevision,
      freshness: reference.status,
      omissionReason: null,
      previewText: reference.authoredPreview ?? null,
    })),
    ...input.envelope.omissions.map((omission) => ({
      category: omission.category,
      referenceId: omission.referenceId,
      observedRevision: null,
      freshness:
        omission.reason === "FORBIDDEN"
          ? ("FORBIDDEN" as const)
          : omission.reason === "UNAVAILABLE"
            ? ("UNAVAILABLE" as const)
            : ("FRESH" as const),
      omissionReason: omission.reason,
      previewText: null,
    })),
  ];
  const durableKeys = referenceRows.map((row) => `${row.category}\u0000${row.referenceId}`);
  if (new Set(durableKeys).size !== durableKeys.length) {
    return error("RUN_CONFIGURATION_INVALID", "Run configuration contains duplicate references.");
  }
  const previewBytes = input.envelope.references.reduce(
    (total, reference) => total + Buffer.byteLength(reference.authoredPreview ?? "", "utf8"),
    0,
  );
  const envelopeDigest = sha256(input.envelope);
  const assemblyDigest = sha256({
    configurationDigest: input.configuration.digest,
    envelopeDigest,
    authoredRunInput: input.authoredRunInput,
  });
  return {
    ok: true,
    value: {
      configuration: input.configuration,
      envelope: input.envelope,
      ...(input.authoredRunInput ? { authoredRunInput: input.authoredRunInput } : {}),
      configurationJson,
      previewBytes,
      envelopeDigest,
      assemblyDigest,
      referenceRows,
    },
  };
}

function currentConfigurationFactsMatch(
  database: Database,
  projectId: string,
  configuration: EffectiveRunConfiguration,
): boolean {
  const authority = configuration.provenance.authority;
  if (!authority) return false;
  const row = database
    .query<
      {
        project_revision: number;
        preset_owner_member_id: string;
        preset_project_id: string | null;
        preset_state: string;
        runner_id: string;
        runner_epoch: number;
        mapping_revision: number;
        profile_id: string;
        profile_version: number;
        profile_fingerprint: string;
        host: string;
        interaction: string;
        repository_mode: string;
        repository_assurance: string;
        maximum_attempts: number;
        deadline_seconds: number;
        context_recipe_id: string | null;
        context_recipe_version: number | null;
        runner_owner_member_id: string;
        current_runner_epoch: number;
        policy_revision: number;
        security_policy_version: number;
        security_digest: string;
        revoked_at: number | null;
        adapter: string;
        supports_native: number;
        supports_orca: number;
        supports_headless: number;
        supports_interactive: number;
      },
      [string, string, number]
    >(
      `SELECT projects.revision AS project_revision,
              presets.owner_member_id AS preset_owner_member_id,
              presets.project_id AS preset_project_id, presets.state AS preset_state,
              versions.runner_id, versions.runner_epoch, versions.mapping_revision,
              versions.profile_id, versions.profile_version, versions.profile_fingerprint,
              versions.host, versions.interaction, versions.repository_mode,
              versions.repository_assurance, versions.maximum_attempts,
              versions.deadline_seconds, versions.context_recipe_id,
              versions.context_recipe_version,
              runners.owner_member_id AS runner_owner_member_id,
              runners.runner_epoch AS current_runner_epoch, runners.policy_revision,
              runners.security_policy_version, runners.security_digest, runners.revoked_at,
              profiles.adapter, profiles.supports_native, profiles.supports_orca,
              profiles.supports_headless, profiles.supports_interactive
       FROM personal_run_presets AS presets
       JOIN personal_run_preset_versions AS versions ON versions.preset_id = presets.id
       JOIN projects ON projects.id = ?
       JOIN runners ON runners.id = versions.runner_id
       JOIN runner_mapping_versions AS mappings ON mappings.runner_id = versions.runner_id
         AND mappings.project_id = projects.id AND mappings.revision = versions.mapping_revision
         AND mappings.revoked_at IS NULL
       JOIN safe_profile_versions AS profiles ON profiles.runner_id = versions.runner_id
         AND profiles.profile_id = versions.profile_id AND profiles.version = versions.profile_version
         AND profiles.fingerprint = versions.profile_fingerprint
       WHERE presets.id = ? AND versions.version = ?`,
    )
    .get(projectId, configuration.presetId, configuration.presetVersion);
  if (
    row?.preset_state !== "ACTIVE" ||
    row.preset_owner_member_id !== configuration.ownerMemberId ||
    (row.preset_project_id !== null && row.preset_project_id !== projectId) ||
    row.runner_id !== configuration.runnerId ||
    row.runner_epoch !== configuration.runnerEpoch ||
    row.current_runner_epoch !== configuration.runnerEpoch ||
    row.mapping_revision !== configuration.mappingRevision ||
    row.profile_id !== configuration.profileId ||
    row.profile_version !== configuration.profileVersion ||
    row.profile_fingerprint !== configuration.profileFingerprint ||
    row.host !== configuration.host ||
    row.interaction !== configuration.interaction ||
    (row.repository_mode === "INSPECT_ONLY" && configuration.repositoryMode !== "INSPECT_ONLY") ||
    row.repository_assurance !== configuration.repositoryAssurance ||
    configuration.maximumAttempts > row.maximum_attempts ||
    configuration.deadlineSeconds > row.deadline_seconds ||
    row.context_recipe_id !== configuration.contextRecipeId ||
    row.context_recipe_version !== configuration.contextRecipeVersion ||
    row.revoked_at !== null ||
    row.adapter !== configuration.runtime ||
    (configuration.host === "NATIVE" ? row.supports_native !== 1 : row.supports_orca !== 1) ||
    (configuration.interaction === "HEADLESS"
      ? row.supports_headless !== 1
      : row.supports_interactive !== 1) ||
    row.project_revision !== authority.projectRevision ||
    row.policy_revision !== authority.runnerPolicyRevision ||
    row.security_policy_version !== authority.securityPolicyVersion ||
    row.security_digest !== authority.securityDigest
  ) {
    return false;
  }
  const storedGates = database
    .query<{ gate_name: string; manifest_fingerprint: string }, [string, number]>(
      `SELECT gate_name, manifest_fingerprint FROM personal_run_preset_gates
       WHERE preset_id = ? AND preset_version = ? AND required = 1`,
    )
    .all(configuration.presetId, configuration.presetVersion);
  if (
    storedGates.some(
      (gate) =>
        !configuration.requiredGates.includes(gate.gate_name) ||
        gate.manifest_fingerprint !== configuration.gateManifestFingerprint,
    )
  ) {
    return false;
  }
  for (const [connectorId, connectorEpoch] of Object.entries(authority.connectorEpochs)) {
    if (
      database
        .query<{ epoch: number }, [string]>(
          "SELECT epoch FROM connector_epochs WHERE connector_id = ? AND review_state = 'READY'",
        )
        .get(connectorId)?.epoch !== connectorEpoch
    ) {
      return false;
    }
  }
  if (authority.exposureRevision === undefined && authority.acknowledgementVersion === undefined) {
    return row.runner_owner_member_id === configuration.ownerMemberId;
  }
  if (authority.exposureRevision === undefined || authority.acknowledgementVersion === undefined)
    return false;
  return Boolean(
    database
      .query<
        { present: number },
        [string, string, number, string, number, string, number, number, string, number, number]
      >(
        `SELECT 1 AS present FROM runner_exposures AS exposures
         JOIN runner_exposure_acknowledgements AS acknowledgements
           ON acknowledgements.id = exposures.acknowledgement_id
         WHERE exposures.runner_id = ? AND exposures.project_id = ?
           AND exposures.mapping_revision = ? AND exposures.profile_id = ?
           AND exposures.profile_version = ? AND exposures.profile_fingerprint = ?
           AND exposures.policy_revision = ? AND exposures.security_policy_version = ?
           AND exposures.security_digest = ? AND exposures.revision = ?
           AND acknowledgements.version = ? AND exposures.revoked_at IS NULL
           AND acknowledgements.revoked_at IS NULL`,
      )
      .get(
        configuration.runnerId,
        projectId,
        configuration.mappingRevision,
        configuration.profileId,
        configuration.profileVersion,
        configuration.profileFingerprint,
        authority.runnerPolicyRevision,
        authority.securityPolicyVersion,
        authority.securityDigest,
        authority.exposureRevision,
        authority.acknowledgementVersion,
      ),
  );
}

export function persistPreparedRunConfigurationSnapshotInTransaction(
  dependencies: Readonly<{
    database: Database;
    clock: () => number;
    id: (prefix: string) => string;
  }>,
  input: Readonly<{ runId: string; prepared: PreparedRunConfigurationSnapshot }>,
): Result<ConfigurationSnapshot> {
  if (!dependencies.database.inTransaction) {
    return error(
      "RUN_CONFIGURATION_TRANSACTION_REQUIRED",
      "Run configuration persistence requires an active transaction.",
    );
  }
  const existing = dependencies.database
    .query<{ present: number }, [string]>(
      "SELECT 1 AS present FROM run_configuration_snapshots WHERE run_id = ?",
    )
    .get(input.runId);
  if (existing) return error("RUN_CONFIGURATION_IMMUTABLE", "Run configuration is immutable.");
  const run = dependencies.database
    .query<
      {
        project_id: string;
        effective_configuration_id: string;
        effective_configuration_version: number;
        effective_configuration_digest: string;
      },
      [string]
    >(
      `SELECT project_id, effective_configuration_id, effective_configuration_version,
              effective_configuration_digest FROM agent_runs WHERE id = ?`,
    )
    .get(input.runId);
  const { prepared } = input;
  if (
    !run ||
    run.project_id !== prepared.configuration.projectId ||
    run.effective_configuration_id !== prepared.configuration.presetId ||
    run.effective_configuration_version !== prepared.configuration.presetVersion ||
    run.effective_configuration_digest !== prepared.configuration.digest
  ) {
    return error("RUN_CONFIGURATION_MISMATCH", "Run configuration does not match the run.");
  }
  if (
    !currentConfigurationFactsMatch(dependencies.database, run.project_id, prepared.configuration)
  ) {
    return error(
      "RUN_CONFIGURATION_AUTHORITY_STALE",
      "Run configuration authority facts are stale.",
      "REFRESH",
    );
  }
  const recipe = dependencies.database
    .query<
      { recipe_digest: string; maximum_references: number; maximum_preview_bytes: number },
      [string, number, string]
    >(
      `SELECT versions.recipe_digest, versions.maximum_references,
              versions.maximum_preview_bytes
       FROM context_recipe_versions AS versions
       JOIN context_recipes AS recipes ON recipes.id = versions.recipe_id
       WHERE versions.recipe_id = ? AND versions.version = ? AND recipes.project_id = ?`,
    )
    .get(
      prepared.envelope.contextRecipe.id,
      prepared.envelope.contextRecipe.version,
      run.project_id,
    );
  if (!recipe || recipe.recipe_digest !== prepared.envelope.contextRecipe.digest) {
    return error("CONTEXT_RECIPE_STALE", "Context recipe provenance is stale.", "REFRESH");
  }
  const categoryLimits = new Map(
    dependencies.database
      .query<{ category: string; maximum_references: number }, [string, number]>(
        `SELECT category, maximum_references FROM context_recipe_category_limits
         WHERE recipe_id = ? AND recipe_version = ?`,
      )
      .all(prepared.envelope.contextRecipe.id, prepared.envelope.contextRecipe.version)
      .map((limit) => [limit.category, limit.maximum_references] as const),
  );
  const selectedCategoryCounts = new Map<string, number>();
  for (const reference of prepared.envelope.references) {
    selectedCategoryCounts.set(
      reference.category,
      (selectedCategoryCounts.get(reference.category) ?? 0) + 1,
    );
  }
  if (
    prepared.envelope.references.length > recipe.maximum_references ||
    prepared.previewBytes > recipe.maximum_preview_bytes ||
    [...selectedCategoryCounts].some(
      ([category, count]) => count > (categoryLimits.get(category) ?? 0),
    )
  ) {
    return error(
      "CONTEXT_RECIPE_BUDGET_EXCEEDED",
      "Bootstrap context exceeds the stored recipe budget.",
    );
  }
  const now = dependencies.clock();
  dependencies.database
    .query(
      `INSERT INTO run_configuration_snapshots(
         run_id, preset_id, preset_version, template_id, template_version,
         context_recipe_id, context_recipe_version, personal_addendum,
         authored_run_input, effective_configuration_json, effective_configuration_digest,
         assembly_digest, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      prepared.configuration.presetId,
      prepared.configuration.presetVersion,
      prepared.configuration.derivedTemplate?.id ?? null,
      prepared.configuration.derivedTemplate?.version ?? null,
      prepared.envelope.contextRecipe.id,
      prepared.envelope.contextRecipe.version,
      prepared.configuration.layers.personalAddendum ?? null,
      prepared.authoredRunInput ?? null,
      prepared.configurationJson,
      prepared.configuration.digest,
      prepared.assemblyDigest,
      now,
    );
  const envelopeId = dependencies.id("envelope");
  dependencies.database
    .query(
      `INSERT INTO context_bootstrap_envelopes(
         id, run_id, recipe_id, recipe_version, reference_count, preview_bytes,
         envelope_digest, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      envelopeId,
      input.runId,
      prepared.envelope.contextRecipe.id,
      prepared.envelope.contextRecipe.version,
      prepared.envelope.references.length,
      prepared.previewBytes,
      prepared.envelopeDigest,
      now,
    );
  for (const [index, reference] of prepared.referenceRows.entries()) {
    dependencies.database
      .query(
        `INSERT INTO context_envelope_references(
           envelope_id, ordinal, category, reference_id, observed_revision, freshness,
           omission_reason, preview_text, preview_digest
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelopeId,
        index + 1,
        reference.category,
        reference.referenceId,
        reference.observedRevision,
        reference.freshness,
        reference.omissionReason,
        reference.previewText,
        reference.previewText ? sha256(reference.previewText) : null,
      );
  }
  return {
    ok: true,
    value: {
      runId: input.runId,
      configuration: prepared.configuration,
      envelope: prepared.envelope,
      ...(prepared.authoredRunInput ? { authoredRunInput: prepared.authoredRunInput } : {}),
      createdAt: now,
    },
  };
}

function parseConfiguration(value: string): EffectiveRunConfiguration | null {
  if (Buffer.byteLength(value, "utf8") > 65_536) return null;
  try {
    const parsed = JSON.parse(value) as EffectiveRunConfiguration;
    return validEffectiveConfiguration(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createConfigurationPersistence(
  dependencies: Readonly<{
    database: Database;
    clock: () => number;
    id: (prefix: string) => string;
  }>,
) {
  return {
    persistRunSnapshot(
      input: Readonly<{
        runId: string;
        configuration: EffectiveRunConfiguration;
        envelope: ReferenceFirstBootstrapEnvelope;
        authoredRunInput?: string;
      }>,
    ): Result<ConfigurationSnapshot> {
      const alreadyStored = dependencies.database
        .query<{ present: number }, [string]>(
          "SELECT 1 AS present FROM run_configuration_snapshots WHERE run_id = ?",
        )
        .get(input.runId);
      if (alreadyStored) {
        return error("RUN_CONFIGURATION_IMMUTABLE", "Run configuration is immutable.");
      }
      const prepared = prepareRunConfigurationSnapshot(input);
      if (!prepared.ok) return prepared;
      try {
        return inImmediateTransaction(dependencies.database, () =>
          persistPreparedRunConfigurationSnapshotInTransaction(dependencies, {
            runId: input.runId,
            prepared: prepared.value,
          }),
        );
      } catch {
        return error("RUN_CONFIGURATION_STORAGE_FAILED", "Run configuration could not be stored.");
      }
    },
    inspectRunSnapshot(runId: string): Result<ConfigurationSnapshot> {
      const row = dependencies.database
        .query<
          {
            effective_configuration_json: string;
            authored_run_input: string | null;
            created_at: number;
            envelope_id: string;
            recipe_id: string;
            recipe_version: number;
            envelope_digest: string;
          },
          [string]
        >(
          `SELECT snapshots.effective_configuration_json, snapshots.authored_run_input,
                  snapshots.created_at, envelopes.id AS envelope_id, envelopes.recipe_id,
                  envelopes.recipe_version, envelopes.envelope_digest
           FROM run_configuration_snapshots AS snapshots
           JOIN context_bootstrap_envelopes AS envelopes ON envelopes.run_id = snapshots.run_id
           WHERE snapshots.run_id = ?`,
        )
        .get(runId);
      if (!row) return error("RUN_CONFIGURATION_NOT_FOUND", "Run configuration was not found.");
      const configuration = parseConfiguration(row.effective_configuration_json);
      if (!configuration) {
        return error("RUN_CONFIGURATION_STORAGE_INVALID", "Stored run configuration is invalid.");
      }
      const references: ReferenceFirstBootstrapEnvelope["references"][number][] = [];
      const omissions: ReferenceFirstBootstrapEnvelope["omissions"][number][] = [];
      const stored = dependencies.database
        .query<
          {
            category: ReferenceFirstBootstrapEnvelope["references"][number]["category"];
            reference_id: string;
            observed_revision: string | null;
            freshness: "FRESH" | "STALE" | "UNAVAILABLE" | "FORBIDDEN";
            omission_reason: ReferenceFirstBootstrapEnvelope["omissions"][number]["reason"] | null;
            preview_text: string | null;
          },
          [string]
        >(
          `SELECT category, reference_id, observed_revision, freshness, omission_reason, preview_text
           FROM context_envelope_references WHERE envelope_id = ? ORDER BY ordinal`,
        )
        .all(row.envelope_id);
      for (const item of stored) {
        if (item.omission_reason) {
          omissions.push({
            category: item.category,
            referenceId: item.reference_id,
            reason: item.omission_reason,
          });
        } else if (
          item.observed_revision !== null &&
          (item.freshness === "FRESH" || item.freshness === "STALE")
        ) {
          references.push({
            category: item.category,
            referenceId: item.reference_id,
            observedRevision: item.observed_revision,
            status: item.freshness,
            ...(item.preview_text ? { authoredPreview: item.preview_text } : {}),
          });
        }
      }
      const envelope: ReferenceFirstBootstrapEnvelope = {
        schemaVersion: 1,
        contextRecipe: {
          id: row.recipe_id,
          version: row.recipe_version,
          digest:
            configuration.contextRecipeId === row.recipe_id
              ? (dependencies.database
                  .query<{ recipe_digest: string }, [string, number]>(
                    `SELECT recipe_digest FROM context_recipe_versions
                   WHERE recipe_id = ? AND version = ?`,
                  )
                  .get(row.recipe_id, row.recipe_version)?.recipe_digest ?? "")
              : "",
        },
        references,
        omissions,
      };
      if (sha256(envelope) !== row.envelope_digest) {
        return error("RUN_CONFIGURATION_STORAGE_INVALID", "Stored run configuration is invalid.");
      }
      return {
        ok: true,
        value: {
          runId,
          configuration,
          envelope,
          ...(row.authored_run_input ? { authoredRunInput: row.authored_run_input } : {}),
          createdAt: row.created_at,
        },
      };
    },
  };
}
