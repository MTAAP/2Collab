import { z } from "zod";
import type { SourceRef } from "./context.ts";
import { IdentifierSchema, InstantSchema, Sha256Schema } from "./ids.ts";

export const GitHubDecimalIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[0-9]+$/);
export const GitHubNodeIdSchema = z.string().min(1).max(128);
const GitHubLoginSchema = z.string().min(1).max(128);
const GitHubNameSchema = z.string().min(1).max(128);
const GitHubTitleSchema = z.string().min(1).max(256);
const GitHubBodySchema = z.string().max(65_536);
const GitHubNumberSchema = z.number().int().positive().max(2_147_483_647);

export const GitHubRepositoryRefSchema = z
  .object({ kind: z.literal("REPOSITORY"), repositoryId: GitHubDecimalIdSchema })
  .strict();
export const GitHubIssueRefSchema = z
  .object({
    kind: z.literal("ISSUE"),
    repositoryId: GitHubDecimalIdSchema,
    number: GitHubNumberSchema,
  })
  .strict();
export const GitHubPullRequestRefSchema = z
  .object({
    kind: z.literal("PULL_REQUEST"),
    repositoryId: GitHubDecimalIdSchema,
    number: GitHubNumberSchema,
  })
  .strict();
export const GitHubMilestoneRefSchema = z
  .object({
    kind: z.literal("MILESTONE"),
    repositoryId: GitHubDecimalIdSchema,
    number: GitHubNumberSchema,
  })
  .strict();
export const GitHubProjectRefSchema = z
  .object({ kind: z.literal("PROJECT"), projectNodeId: GitHubNodeIdSchema })
  .strict();

export const GitHubReferenceSchema = z.discriminatedUnion("kind", [
  GitHubIssueRefSchema,
  GitHubPullRequestRefSchema,
  GitHubMilestoneRefSchema,
  GitHubProjectRefSchema,
]);
export const GitHubWorkItemReferenceSchema = z.discriminatedUnion("kind", [
  GitHubIssueRefSchema,
  GitHubPullRequestRefSchema,
]);

export type GitHubRepositoryRef = Readonly<z.infer<typeof GitHubRepositoryRefSchema>>;
export type GitHubIssueRef = Readonly<z.infer<typeof GitHubIssueRefSchema>>;
export type GitHubPullRequestRef = Readonly<z.infer<typeof GitHubPullRequestRefSchema>>;
export type GitHubMilestoneRef = Readonly<z.infer<typeof GitHubMilestoneRefSchema>>;
export type GitHubProjectRef = Readonly<z.infer<typeof GitHubProjectRefSchema>>;
export type GitHubReference = Readonly<z.infer<typeof GitHubReferenceSchema>>;
export type GitHubWorkItemReference = Readonly<z.infer<typeof GitHubWorkItemReferenceSchema>>;

const LabelsSchema = z.array(z.string().min(1).max(128)).max(100);
const AssigneesSchema = z.array(GitHubLoginSchema).max(100);
const SourceRevisionSchema = z.string().min(1).max(256);
const CommitShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

const RepositoryProjectionSchema = z
  .object({
    kind: z.literal("REPOSITORY"),
    repositoryId: GitHubDecimalIdSchema,
    repositoryNodeId: GitHubNodeIdSchema,
    ownerLogin: GitHubLoginSchema,
    name: GitHubNameSchema,
    permissionDigest: Sha256Schema,
  })
  .strict();
const IssueProjectionSchema = z
  .object({
    kind: z.literal("ISSUE"),
    repositoryId: GitHubDecimalIdSchema,
    number: GitHubNumberSchema,
    title: GitHubTitleSchema,
    state: z.enum(["OPEN", "CLOSED"]),
    stateReason: z.enum(["COMPLETED", "NOT_PLANNED", "DUPLICATE", "REOPENED"]).nullable().optional(),
    labels: LabelsSchema,
    assignees: AssigneesSchema,
    milestoneNumber: GitHubNumberSchema.nullable().optional(),
    commentCount: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict();
const PullRequestProjectionSchema = z
  .object({
    kind: z.literal("PULL_REQUEST"),
    repositoryId: GitHubDecimalIdSchema,
    number: GitHubNumberSchema,
    title: GitHubTitleSchema,
    state: z.enum(["OPEN", "CLOSED"]),
    draft: z.boolean(),
    merged: z.boolean(),
    headSha: CommitShaSchema,
    baseRef: z.string().min(1).max(256),
    labels: LabelsSchema,
    assignees: AssigneesSchema,
    milestoneNumber: GitHubNumberSchema.nullable().optional(),
  })
  .strict();
const MilestoneProjectionSchema = z
  .object({
    kind: z.literal("MILESTONE"),
    repositoryId: GitHubDecimalIdSchema,
    number: GitHubNumberSchema,
    title: GitHubTitleSchema,
    description: z.string().max(4_096),
    state: z.enum(["OPEN", "CLOSED"]),
    dueOn: z.string().datetime({ offset: true }).nullable(),
    openIssues: z.number().int().nonnegative().max(1_000_000),
    closedIssues: z.number().int().nonnegative().max(1_000_000),
  })
  .strict();
const ProjectProjectionSchema = z
  .object({
    kind: z.literal("PROJECT"),
    projectNodeId: GitHubNodeIdSchema,
    title: GitHubTitleSchema,
    itemCount: z.number().int().nonnegative().max(100_000),
    unsupportedRepositoryItems: z.number().int().nonnegative().max(100_000),
    fields: z
      .array(
        z
          .object({ id: GitHubNodeIdSchema, name: GitHubNameSchema, dataType: z.string().min(1).max(64) })
          .strict(),
      )
      .max(100),
  })
  .strict();
const ProjectItemProjectionSchema = z
  .object({
    kind: z.literal("PROJECT_ITEM"),
    projectNodeId: GitHubNodeIdSchema,
    itemId: GitHubNodeIdSchema,
    content: GitHubWorkItemReferenceSchema,
    fieldValues: z.record(GitHubNodeIdSchema, z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()])),
  })
  .strict();
const RedactedProjectionSchema = z
  .object({
    kind: z.literal("REDACTED"),
    sourceKind: z.enum(["REPOSITORY", "ISSUE", "PULL_REQUEST", "MILESTONE", "PROJECT", "PROJECT_ITEM"]),
    unsupportedRepositoryItems: z.number().int().nonnegative().max(100_000).optional(),
  })
  .strict();

export const GitHubProjectionSchema = z.discriminatedUnion("kind", [
  RepositoryProjectionSchema,
  IssueProjectionSchema,
  PullRequestProjectionSchema,
  MilestoneProjectionSchema,
  ProjectProjectionSchema,
  ProjectItemProjectionSchema,
  RedactedProjectionSchema,
]);
export type GitHubProjection = Readonly<z.infer<typeof GitHubProjectionSchema>>;

export const GitHubProjectFieldValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("TEXT"), value: z.string().max(256) }).strict(),
  z.object({ kind: z.literal("NUMBER"), value: z.number().finite() }).strict(),
  z.object({ kind: z.literal("DATE"), value: z.string().date() }).strict(),
  z.object({ kind: z.literal("SINGLE_SELECT"), optionId: GitHubNodeIdSchema }).strict(),
  z.object({ kind: z.literal("ITERATION"), iterationId: GitHubNodeIdSchema }).strict(),
  z.object({ kind: z.literal("CLEAR") }).strict(),
]);
export type GitHubProjectFieldValue = Readonly<z.infer<typeof GitHubProjectFieldValueSchema>>;

const CreateIssueSchema = z
  .object({ kind: z.literal("CREATE_ISSUE"), repository: GitHubRepositoryRefSchema, title: GitHubTitleSchema, body: GitHubBodySchema })
  .strict();
const EditIssueSchema = z
  .object({ kind: z.literal("EDIT_ISSUE"), issue: GitHubIssueRefSchema, title: GitHubTitleSchema.optional(), body: GitHubBodySchema.optional() })
  .strict()
  .refine((value) => value.title !== undefined || value.body !== undefined, "Issue edit must change a field");
const AddCommentSchema = z
  .object({ kind: z.literal("ADD_COMMENT"), issue: GitHubIssueRefSchema, body: GitHubBodySchema.min(1) })
  .strict();
const SetLabelsSchema = z.object({ kind: z.literal("SET_LABELS"), issue: GitHubIssueRefSchema, labels: LabelsSchema }).strict();
const SetAssigneesSchema = z.object({ kind: z.literal("SET_ASSIGNEES"), issue: GitHubIssueRefSchema, logins: AssigneesSchema }).strict();
const SetMilestoneSchema = z
  .object({ kind: z.literal("SET_MILESTONE"), item: GitHubWorkItemReferenceSchema, milestoneNumber: GitHubNumberSchema.nullable() })
  .strict();
const SetIssueStateSchema = z
  .object({
    kind: z.literal("SET_ISSUE_STATE"),
    issue: GitHubIssueRefSchema,
    state: z.enum(["OPEN", "CLOSED"]),
    reason: z.enum(["COMPLETED", "NOT_PLANNED", "DUPLICATE", "REOPENED"]),
  })
  .strict()
  .refine(
    (value) =>
      (value.state === "OPEN" && value.reason === "REOPENED") ||
      (value.state === "CLOSED" && value.reason !== "REOPENED"),
    "Issue state and reason are inconsistent",
  );
const CreateMilestoneSchema = z
  .object({
    kind: z.literal("CREATE_MILESTONE"),
    repository: GitHubRepositoryRefSchema,
    title: GitHubTitleSchema,
    description: z.string().max(4_096),
    dueOn: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
const EditMilestoneSchema = z
  .object({
    kind: z.literal("EDIT_MILESTONE"),
    milestone: GitHubMilestoneRefSchema,
    title: GitHubTitleSchema.optional(),
    description: z.string().max(4_096).optional(),
    dueOn: z.string().datetime({ offset: true }).nullable().optional(),
    state: z.enum(["OPEN", "CLOSED"]).optional(),
  })
  .strict()
  .refine(
    (value) => value.title !== undefined || value.description !== undefined || value.dueOn !== undefined || value.state !== undefined,
    "Milestone edit must change a field",
  );
const AddProjectItemSchema = z.object({ kind: z.literal("ADD_PROJECT_ITEM"), project: GitHubProjectRefSchema, item: GitHubWorkItemReferenceSchema }).strict();
const RemoveProjectItemSchema = z.object({ kind: z.literal("REMOVE_PROJECT_ITEM"), project: GitHubProjectRefSchema, itemId: GitHubNodeIdSchema }).strict();
const SetProjectFieldSchema = z
  .object({ kind: z.literal("SET_PROJECT_FIELD"), project: GitHubProjectRefSchema, itemId: GitHubNodeIdSchema, fieldId: GitHubNodeIdSchema, value: GitHubProjectFieldValueSchema })
  .strict();
const MoveProjectItemSchema = z
  .object({ kind: z.literal("MOVE_PROJECT_ITEM"), project: GitHubProjectRefSchema, itemId: GitHubNodeIdSchema, afterItemId: GitHubNodeIdSchema.nullable() })
  .strict();

export const GitHubMutationSchema = z.discriminatedUnion("kind", [
  CreateIssueSchema,
  EditIssueSchema,
  AddCommentSchema,
  SetLabelsSchema,
  SetAssigneesSchema,
  SetMilestoneSchema,
  SetIssueStateSchema,
  CreateMilestoneSchema,
  EditMilestoneSchema,
  AddProjectItemSchema,
  RemoveProjectItemSchema,
  SetProjectFieldSchema,
  MoveProjectItemSchema,
]);
export type GitHubMutation = Readonly<z.infer<typeof GitHubMutationSchema>>;

export const GitHubCheckObservationSchema = z
  .object({
    checkRunId: GitHubDecimalIdSchema,
    repositoryId: GitHubDecimalIdSchema,
    commitSha: CommitShaSchema,
    checkName: z.string().min(1).max(256),
    status: z.enum(["QUEUED", "IN_PROGRESS", "COMPLETED"]),
    conclusion: z.enum(["SUCCESS", "FAILURE", "NEUTRAL", "CANCELLED", "SKIPPED", "TIMED_OUT", "ACTION_REQUIRED"]).nullable(),
    scopeDigest: Sha256Schema,
    observedAt: InstantSchema,
    fresh: z.boolean(),
  })
  .strict();
export type GitHubCheckObservation = Readonly<z.infer<typeof GitHubCheckObservationSchema>>;

export const SourceDependencySchema = z
  .object({
    reference: GitHubWorkItemReferenceSchema,
    state: z.enum(["UNRESOLVED", "RESOLVED", "STALE", "UNAVAILABLE"]),
    authoritativeUrl: z.string().url().max(2_048),
    sourceRevision: SourceRevisionSchema.optional(),
  })
  .strict();
export type SourceDependency = Readonly<z.infer<typeof SourceDependencySchema>>;

export function githubReferenceKey(reference: GitHubReference): string {
  if (reference.kind === "PROJECT") return `PROJECT:${reference.projectNodeId}`;
  return `${reference.kind}:${reference.repositoryId}:${reference.number}`;
}

export function githubReferenceToSourceRef(
  connectorId: string,
  reference: GitHubWorkItemReference,
  observedRevision = "UNOBSERVED",
): SourceRef {
  return {
    kind: reference.kind === "ISSUE" ? "GITHUB_ISSUE" : "GITHUB_PULL_REQUEST",
    connectorId: IdentifierSchema.parse(connectorId) as never,
    sourceItemId: `${reference.repositoryId}:${reference.number}`,
    observedRevision,
  };
}

export function sourceRefToGitHubReference(reference: SourceRef): GitHubWorkItemReference | null {
  if (reference.kind !== "GITHUB_ISSUE" && reference.kind !== "GITHUB_PULL_REQUEST") return null;
  const match = /^(\d{1,32}):(\d+)$/.exec(reference.sourceItemId);
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return {
    kind: reference.kind === "GITHUB_ISSUE" ? "ISSUE" : "PULL_REQUEST",
    repositoryId: match[1] ?? "",
    number,
  };
}
