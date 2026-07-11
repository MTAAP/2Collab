import { z } from "zod";
import type { GitHubProjection } from "../../../shared/contracts/github.ts";

const MilestonePayloadSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(256),
    description: z.string().nullable(),
    state: z.enum(["open", "closed"]),
    due_on: z.string().datetime({ offset: true }).nullable(),
    open_issues: z.number().int().nonnegative(),
    closed_issues: z.number().int().nonnegative(),
  })
  .passthrough();
export function normalizeGitHubMilestone(repositoryId: string, payload: unknown): GitHubProjection {
  const value = MilestonePayloadSchema.parse(payload);
  return {
    kind: "MILESTONE",
    repositoryId,
    number: value.number,
    title: value.title,
    description: value.description ?? "",
    state: value.state === "open" ? "OPEN" : "CLOSED",
    dueOn: value.due_on,
    openIssues: value.open_issues,
    closedIssues: value.closed_issues,
  };
}
