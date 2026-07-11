import type { GitHubProjection } from "../../../../shared/contracts/github.ts";
export function GitHubMilestones({ items }: { items: readonly GitHubProjection[] }) {
  return (
    <section aria-label="GitHub milestones">
      {items
        .filter((item) => item.kind === "MILESTONE")
        .map((item) => (
          <article key={`${item.repositoryId}:${item.number}`}>
            <h3>{item.title}</h3>
            <p>
              {item.openIssues} open, {item.closedIssues} closed
            </p>
          </article>
        ))}
    </section>
  );
}
