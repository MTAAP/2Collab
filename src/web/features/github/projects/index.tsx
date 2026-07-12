import type { GitHubProjection } from "../../../../shared/contracts/github.ts";
export function GitHubProjects({ items }: { items: readonly GitHubProjection[] }) {
  return (
    <section aria-label="GitHub Projects">
      {items
        .filter((item) => item.kind === "PROJECT")
        .map((item) => (
          <article key={item.projectNodeId}>
            <h3>{item.title}</h3>
            <p>{item.itemCount} selected items</p>
            {item.unsupportedRepositoryItems > 0 && (
              <p>{item.unsupportedRepositoryItems} out-of-scope items redacted</p>
            )}
          </article>
        ))}
    </section>
  );
}
