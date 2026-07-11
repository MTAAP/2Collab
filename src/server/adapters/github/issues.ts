import { z } from "zod";
import type { GitHubIssueRef, GitHubProjection } from "../../../shared/contracts/github.ts";

export const GitHubIssueApiPayloadSchema = z
  .object({
    id: z.number().int().positive(),
    number: z.number().int().positive(),
    title: z.string().min(1).max(256),
    state: z.enum(["open", "closed"]),
    state_reason: z
      .enum(["completed", "not_planned", "duplicate", "reopened"])
      .nullable()
      .optional(),
    labels: z
      .array(z.union([z.string(), z.object({ name: z.string().nullable() }).passthrough()]))
      .max(100),
    assignees: z
      .array(z.object({ login: z.string() }).passthrough())
      .max(100)
      .nullable(),
    milestone: z.object({ number: z.number().int().positive() }).passthrough().nullable(),
    comments: z.number().int().nonnegative(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .passthrough();

export function normalizeGitHubIssue(repositoryId: string, payload: unknown): GitHubProjection {
  const issue = GitHubIssueApiPayloadSchema.parse(payload);
  return {
    kind: "ISSUE",
    repositoryId,
    number: issue.number,
    title: issue.title,
    state: issue.state === "open" ? "OPEN" : "CLOSED",
    stateReason: issue.state_reason
      ? (issue.state_reason.toUpperCase() as "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" | "REOPENED")
      : null,
    labels: issue.labels.flatMap((label) =>
      typeof label === "string" ? [label] : label.name ? [label.name] : [],
    ),
    assignees: (issue.assignees ?? []).map((actor) => actor.login),
    milestoneNumber: issue.milestone?.number ?? null,
    commentCount: issue.comments,
  };
}

export function issueApiPath(owner: string, repository: string, issue: GitHubIssueRef): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issue.number}`;
}
