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
