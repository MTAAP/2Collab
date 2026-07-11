import { z } from "zod";
import type { CommandResult, LaunchRun } from "../../../shared/contracts/commands.ts";
import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import { CommitShaSchema, IdentifierSchema, Sha256Schema } from "../../../shared/contracts/ids.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { GitRefSchema } from "../../../shared/contracts/runners.ts";

export type ExecutionAuthorityPort = ExecutionAuthority;

export type LaunchAuthorityFacts = Readonly<{
  projectRevision: number;
  runnerOwnerMemberId: string;
  runnerPolicyRevision: number;
  profileVersion: number;
  profileFingerprint: string;
  authorizationSource: "OWNER" | "TEAM_EXPOSURE";
  securityPolicyVersion: number;
  securityDigest: string;
  resolvedBaseCommit: string;
  baseBranch: string;
  permitSeconds: number;
  authoritySessionSeconds: number;
  authorityRenewalSeconds: number;
  mutationDisconnectGraceSeconds: number;
  maximumAttempts: number;
  deadlineAt: number;
  connectorEpochs: Readonly<Record<string, number>>;
}>;

export const LaunchAuthorityFactsSchema = z
  .object({
    projectRevision: z.number().int().positive(),
    runnerOwnerMemberId: IdentifierSchema,
    runnerPolicyRevision: z.number().int().positive(),
    profileVersion: z.number().int().positive(),
    profileFingerprint: Sha256Schema,
    authorizationSource: z.enum(["OWNER", "TEAM_EXPOSURE"]),
    securityPolicyVersion: z.number().int().positive(),
    securityDigest: Sha256Schema,
    resolvedBaseCommit: CommitShaSchema,
    baseBranch: GitRefSchema,
    permitSeconds: z.number().int().min(1).max(300),
    authoritySessionSeconds: z.number().int().min(1).max(300),
    authorityRenewalSeconds: z.number().int().min(1).max(300),
    mutationDisconnectGraceSeconds: z.number().int().min(1).max(300),
    maximumAttempts: z.number().int().min(1).max(1_000),
    deadlineAt: z.number().int().positive(),
    connectorEpochs: z
      .record(IdentifierSchema, z.number().int().positive())
      .refine((epochs) => Object.keys(epochs).length <= 32),
  })
  .strict()
  .refine(
    (facts) =>
      facts.authorityRenewalSeconds <= facts.authoritySessionSeconds && facts.deadlineAt > 0,
  );

export type LaunchPersistenceInput = Readonly<{
  command: LaunchRun;
  authority: LaunchAuthorityFacts;
}>;

export type CommittedLaunch = Readonly<{
  result: Extract<CommandResult, { kind: "LAUNCH_RUN" }>;
  outboxIds: readonly string[];
}>;

export interface LaunchPersistence {
  create(input: LaunchPersistenceInput): Promise<Result<CommittedLaunch>>;
}
