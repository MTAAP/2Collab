import type { GitHubProjection } from "../../../../shared/contracts/github.ts";
export function GitHubPullRequests({ items }: { items: readonly GitHubProjection[] }) {
  return (
    <section aria-label="GitHub pull requests">
      {items
        .filter((item) => item.kind === "PULL_REQUEST")
        .map((item) => (
          <article key={`${item.repositoryId}:${item.number}`}>
            <h3>
              Pull request {item.number}: {item.title}
            </h3>
            <p>{item.merged ? "MERGED" : item.state}</p>
          </article>
        ))}
    </section>
  );
}
