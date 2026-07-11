import { z } from "zod";
import type { Sha256 } from "./ids.ts";
import { IdentifierSchema, Sha256Schema } from "./ids.ts";

export type EffectiveRunConfigurationRef = Readonly<{
  configurationId: string;
  version: number;
  digest: Sha256;
}>;

export const EffectiveRunConfigurationRefSchema = z
  .object({
    configurationId: IdentifierSchema,
    version: z.number().int().positive(),
    digest: Sha256Schema,
  })
  .strict();

export type RuntimeAdapter = "CLAUDE" | "CODEX" | "PI" | "OPENCODE";
export type ExecutionHost = "NATIVE" | "ORCA";
export type InteractionMode = "HEADLESS" | "INTERACTIVE";
export type RepositoryMode = "INSPECT_ONLY" | "MUTATING";
export type RepositoryAssurance = "ADVISORY" | "ENFORCED";
export type RunExecutionPolicy = "ONCE" | "MANAGED_LOOP";

export type ManagedLoopConfiguration = Readonly<{
  maximumIterations: number;
  cadenceSeconds: number;
  stopPolicyDigest: Sha256;
  unknownGraceSeconds: number;
  unknownBackoffInitialSeconds: number;
  unknownBackoffMaxSeconds: number;
}>;

export type PersonalRunPresetVersion = Readonly<{
  presetId: string;
  presetVersion: number;
  ownerMemberId: string;
  projectId?: string;
  runtime: RuntimeAdapter;
  runnerId: string;
  runnerEpoch: number;
  mappingRevision: number;
  profileId: string;
  profileVersion: number;
  profileFingerprint: string;
  host: ExecutionHost;
  interaction: InteractionMode;
  repositoryMode: RepositoryMode;
  repositoryAssurance: RepositoryAssurance;
  executionPolicy: RunExecutionPolicy;
  managedLoop?: ManagedLoopConfiguration;
  maximumAttempts: number;
  deadlineSeconds: number;
  derivedTemplate?: Readonly<{ id: string; version: number }>;
  contextRecipeId?: string;
  contextRecipeVersion?: number;
  requiredGates: readonly string[];
  gateManifestFingerprint?: Sha256;
  reusableGoalTemplate?: string;
  reusableInstructionTemplate?: string;
  personalAddendum?: string;
}>;

export type EffectiveRunConfiguration = PersonalRunPresetVersion &
  Readonly<{
    digest: Sha256;
    layers: Readonly<{
      teamCore?: string;
      typedVariables: Readonly<Record<string, string | number | boolean>>;
      personalAddendum?: string;
      runGoal: string;
      authoredRunInput?: string;
    }>;
    provenance: Readonly<{
      preset: Readonly<{ id: string; version: number }>;
      teamTemplate?: Readonly<{ id: string; version: number }>;
      contextRecipe?: Readonly<{ id: string; version: number }>;
      binding: Readonly<{
        runnerId: string;
        runnerEpoch: number;
        mappingRevision: number;
        profileId: string;
        profileVersion: number;
        profileFingerprint: string;
      }>;
      authority?: Readonly<{
        projectRevision: number;
        runnerPolicyRevision: number;
        securityPolicyVersion: number;
        securityDigest: Sha256;
        exposureRevision?: number;
        acknowledgementVersion?: number;
        connectorEpochs: Readonly<Record<string, number>>;
        grantIds: readonly string[];
      }>;
    }>;
    visibleOverrides: Readonly<{
      repositoryMode?: RepositoryMode;
      repositoryAssurance?: RepositoryAssurance;
      maximumAttempts?: number;
      deadlineSeconds?: number;
      requiredGates?: readonly string[];
    }>;
  }>;

const InstructionVariableSchema = z.union([
  z.string().max(2_048),
  z.number().finite(),
  z.boolean(),
]);

export const EffectiveInstructionLayersSchema = z
  .object({
    teamCore: z.string().min(1).max(16_384).optional(),
    typedVariables: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), InstructionVariableSchema)
      .refine((variables) => Object.keys(variables).length <= 64),
    personalAddendum: z.string().min(1).max(16_384).optional(),
    runGoal: z.string().min(1).max(16_384),
    authoredRunInput: z.string().min(1).max(16_384).optional(),
  })
  .strict()
  .refine(
    (layers) => new TextEncoder().encode(JSON.stringify(layers)).byteLength <= 32 * 1_024,
    "Instruction layers exceed the launch budget",
  );

export const EffectiveInstructionEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    configurationDigest: Sha256Schema,
    assemblyDigest: Sha256Schema,
    contextEnvelopeDigest: Sha256Schema,
    layers: EffectiveInstructionLayersSchema,
  })
  .strict();

export type EffectiveInstructionLayers = Readonly<z.infer<typeof EffectiveInstructionLayersSchema>>;
export type EffectiveInstructionEnvelope = Readonly<
  z.infer<typeof EffectiveInstructionEnvelopeSchema>
>;

export type PersonalRunPreset = Readonly<{
  id: string;
  ownerMemberId: string;
  projectId?: string;
  displayName: string;
  state: "ACTIVE" | "ARCHIVED";
  currentVersion: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}>;

export type ProjectPersonalPresetDefault = Readonly<{
  ownerMemberId: string;
  projectId: string;
  presetId: string;
  presetVersion: number;
  revision: number;
  updatedAt: number;
}>;
