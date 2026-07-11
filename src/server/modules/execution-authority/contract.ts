import { z } from "zod";
import type { LaunchRun } from "../../../shared/contracts/commands.ts";
import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import type { CommandResult } from "../../../shared/contracts/commands.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { GitRefSchema } from "../../../shared/contracts/runners.ts";
import { CommitShaSchema, IdentifierSchema, Sha256Schema } from "../../../shared/contracts/ids.ts";

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
  })
  .strict()
  .refine((facts) => facts.authorityRenewalSeconds <= facts.authoritySessionSeconds);

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
