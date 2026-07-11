import type { GitHubProjection } from "../../../shared/contracts/github.ts";

export type GitHubProjectItemInput = Readonly<{
  itemId: string;
  repositoryId?: string;
  number?: number;
  title?: string;
}>;
export function normalizeSelectedGitHubProject(
  input: Readonly<{
    projectNodeId: string;
    title: string;
    selectedRepositoryIds: ReadonlySet<string>;
    items: readonly GitHubProjectItemInput[];
  }>,
): GitHubProjection {
  let supported = 0;
  let unsupported = 0;
  for (const item of input.items) {
    if (item.repositoryId && input.selectedRepositoryIds.has(item.repositoryId)) supported += 1;
    else unsupported += 1;
  }
  return {
    kind: "PROJECT",
    projectNodeId: input.projectNodeId,
    title: input.title,
    itemCount: supported,
    unsupportedRepositoryItems: unsupported,
    fields: [],
  };
}
