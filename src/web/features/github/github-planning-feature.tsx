import { useEffect, useState } from "react";
import { z } from "zod";
import { GitHubProjectionSchema, type GitHubProjection } from "../../../shared/contracts/github.ts";
import { GitHubIssues } from "./issues/index.tsx";
import { GitHubMilestones } from "./milestones/index.tsx";
import { GitHubProjects } from "./projects/index.tsx";
import { GitHubPullRequests } from "./pull-requests/index.tsx";

const PlanningResultSchema = z
  .object({ ok: z.literal(true), value: z.array(GitHubProjectionSchema).max(1_000) })
  .strict();

export function GitHubPlanningFeature() {
  const [items, setItems] = useState<readonly GitHubProjection[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/v1/projects/project_1/github/planning")
      .then((response) => response.json())
      .then((value) => PlanningResultSchema.parse(value).value)
      .then((value) => {
        if (active) setItems(value);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const issues = items.filter((item) => item.kind === "ISSUE");
  return (
    <div className="feature-page">
      <header className="page-header">
        <div>
          <small>AUTHORITATIVE SOURCE</small>
          <h1>GitHub planning</h1>
          <p>Issue, pull request, Milestone, and selected Project state observed from GitHub.</p>
        </div>
      </header>
      {unavailable && <p role="alert">GitHub planning is unavailable.</p>}
      <section className="planning-board" aria-label="GitHub planning board">
        <section aria-label="Backlog">
          <h2>Backlog</h2>
          <GitHubIssues
            items={issues.filter(
              (item) => item.kind === "ISSUE" && !item.labels.includes("in-progress"),
            )}
          />
        </section>
        <section aria-label="In progress">
          <h2>In progress</h2>
          <GitHubIssues
            items={issues.filter(
              (item) => item.kind === "ISSUE" && item.labels.includes("in-progress"),
            )}
          />
        </section>
      </section>
      <GitHubPullRequests items={items} />
      <GitHubMilestones items={items} />
      <GitHubProjects items={items} />
    </div>
  );
}
