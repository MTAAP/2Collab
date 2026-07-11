import { CommitShaSchema, IdentifierSchema } from "../../shared/contracts/ids.ts";
import { GitRefSchema, type RepositoryBaseObservation } from "../../shared/contracts/runners.ts";

export interface RepositoryObservationGit {
  run(
    repositoryRoot: string,
    args: readonly string[],
  ): Promise<Readonly<{ exitCode: number; stdout: string }>>;
}

const processGit: RepositoryObservationGit = {
  async run(repositoryRoot, args) {
    const child = Bun.spawn(["git", "-C", repositoryRoot, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { exitCode, stdout };
  },
};

export async function observeRepositoryBase(
  input: Readonly<{
    projectId: string;
    mappingRevision: number;
    repositoryRoot: string;
    baseBranch: string;
  }>,
  dependencies: Readonly<{ git?: RepositoryObservationGit }> = {},
): Promise<RepositoryBaseObservation> {
  const projectId = IdentifierSchema.safeParse(input.projectId);
  const baseBranch = GitRefSchema.safeParse(input.baseBranch);
  if (
    !projectId.success ||
    !baseBranch.success ||
    !Number.isInteger(input.mappingRevision) ||
    input.mappingRevision < 1 ||
    input.repositoryRoot.length < 1
  )
    throw new Error("REPOSITORY_BASE_UNAVAILABLE");
  const observed = await (dependencies.git ?? processGit).run(input.repositoryRoot, [
    "rev-parse",
    "--verify",
    `refs/heads/${baseBranch.data}^{commit}`,
  ]);
  const commit = CommitShaSchema.safeParse(observed.stdout.trim());
  if (observed.exitCode !== 0 || !commit.success) throw new Error("REPOSITORY_BASE_UNAVAILABLE");
  return {
    projectId: projectId.data as never,
    mappingRevision: input.mappingRevision,
    baseBranch: baseBranch.data,
    baseCommit: commit.data as never,
  };
}
