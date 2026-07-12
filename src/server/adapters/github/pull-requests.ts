import { z } from "zod";
import type { GitHubProjection } from "../../../shared/contracts/github.ts";

const PullRequestPayloadSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(256),
    state: z.enum(["open", "closed"]),
    draft: z.boolean(),
    merged: z.boolean().optional().default(false),
    head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }).passthrough(),
    base: z.object({ ref: z.string().min(1).max(256) }).passthrough(),
    labels: z.array(z.object({ name: z.string().nullable() }).passthrough()).max(100),
    assignees: z
      .array(z.object({ login: z.string() }).passthrough())
      .max(100)
      .nullable(),
    milestone: z.object({ number: z.number().int().positive() }).passthrough().nullable(),
  })
  .passthrough();

export function normalizeGitHubPullRequest(
  repositoryId: string,
  payload: unknown,
): GitHubProjection {
  const value = PullRequestPayloadSchema.parse(payload);
  return {
    kind: "PULL_REQUEST",
    repositoryId,
    number: value.number,
    title: value.title,
    state: value.state === "open" ? "OPEN" : "CLOSED",
    draft: value.draft,
    merged: value.merged,
    headSha: value.head.sha,
    baseRef: value.base.ref,
    labels: value.labels.flatMap((label) => (label.name ? [label.name] : [])),
    assignees: (value.assignees ?? []).map((actor) => actor.login),
    milestoneNumber: value.milestone?.number ?? null,
  };
}
