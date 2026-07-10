import { z } from "zod";
import type {
  CommitSha,
  ConnectedRepositoryId,
  CustomLaunchProfileVersionId,
  RegisteredRunnerId,
} from "./ids.ts";
import { CommitShaSchema, IdentifierSchema, RevisionSchema } from "./ids.ts";

export type RepositoryMode = "MUTATING" | "INSPECT_ONLY";
export type RepositoryAssurance = "ADVISORY" | "ENFORCED";
export type ExecutionHost = "NATIVE" | "ORCA";
export type InteractionMode = "HEADLESS" | "INTERACTIVE";

export type RepositoryRequest = Readonly<{
  repositoryId: ConnectedRepositoryId;
  mode: RepositoryMode;
  assurance: RepositoryAssurance;
  base:
    | Readonly<{ kind: "EXACT"; commitSha: CommitSha }>
    | Readonly<{ kind: "RESOLVE_DEFAULT_BASE" }>;
  intendedBranch?: string;
}>;

export type ExecutionSelection = Readonly<{
  runnerId: RegisteredRunnerId;
  expectedRunnerEpoch: number;
  projectMappingRevision: number;
  profileVersionId: CustomLaunchProfileVersionId;
  exposureRevision?: number;
  host: ExecutionHost;
  interaction: InteractionMode;
}>;

export type RunnerPolicyReplacement = Readonly<{
  audience: "OWNER_ONLY" | "TEAM";
  maximumConcurrentAttempts: number;
}>;

export type EligibleTarget = Readonly<{
  runnerId: RegisteredRunnerId;
  profileVersionId: CustomLaunchProfileVersionId;
  host: ExecutionHost;
  interaction: InteractionMode;
  assurance: RepositoryAssurance;
}>;

export const RepositoryRequestSchema = z
  .object({
    repositoryId: IdentifierSchema,
    mode: z.enum(["MUTATING", "INSPECT_ONLY"]),
    assurance: z.enum(["ADVISORY", "ENFORCED"]),
    base: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("EXACT"), commitSha: CommitShaSchema }).strict(),
      z.object({ kind: z.literal("RESOLVE_DEFAULT_BASE") }).strict(),
    ]),
    intendedBranch: z.string().min(1).max(255).optional(),
  })
  .strict();

export const ExecutionSelectionSchema = z
  .object({
    runnerId: IdentifierSchema,
    expectedRunnerEpoch: RevisionSchema,
    projectMappingRevision: RevisionSchema,
    profileVersionId: IdentifierSchema,
    exposureRevision: RevisionSchema.optional(),
    host: z.enum(["NATIVE", "ORCA"]),
    interaction: z.enum(["HEADLESS", "INTERACTIVE"]),
  })
  .strict();
