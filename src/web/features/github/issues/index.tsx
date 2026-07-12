import type { GitHubProjection } from "../../../../shared/contracts/github.ts";
export function GitHubIssues({ items }: { items: readonly GitHubProjection[] }) {
  return (
    <section aria-label="GitHub issues">
      {items
        .filter((item) => item.kind === "ISSUE")
        .map((item) => (
          <article key={`${item.repositoryId}:${item.number}`}>
            <h3>
              Issue {item.number}: {item.title}
            </h3>
            <p>{item.state}</p>
          </article>
        ))}
    </section>
  );
}
