import { describe, expect, test } from "bun:test";
import { observeRepositoryBase } from "../../src/runner/repository/base-observation.ts";

describe("runner repository base observation", () => {
  test("resolves the configured local base ref to one exact commit without sending a path", async () => {
    const calls: unknown[] = [];
    const result = await observeRepositoryBase(
      {
        projectId: "project_1",
        mappingRevision: 3,
        repositoryRoot: "/private/repository",
        baseBranch: "main",
      },
      {
        git: {
          async run(root, args) {
            calls.push({ root, args });
            return { exitCode: 0, stdout: `${"a".repeat(40)}\n` };
          },
        },
      },
    );
    expect(result).toEqual({
      projectId: "project_1",
      mappingRevision: 3,
      baseBranch: "main",
      baseCommit: "a".repeat(40),
    } as never);
    expect(JSON.stringify(result)).not.toContain("/private/repository");
    expect(calls).toEqual([
      {
        root: "/private/repository",
        args: ["rev-parse", "--verify", "refs/heads/main^{commit}"],
      },
    ]);
  });

  test("fails closed when the configured base ref is unavailable or not an exact commit", async () => {
    for (const response of [
      { exitCode: 1, stdout: "" },
      { exitCode: 0, stdout: "main" },
      { exitCode: 0, stdout: `${"A".repeat(40)}\n` },
    ]) {
      await expect(
        observeRepositoryBase(
          {
            projectId: "project_1",
            mappingRevision: 3,
            repositoryRoot: "/private/repository",
            baseBranch: "main",
          },
          { git: { run: async () => response } },
        ),
      ).rejects.toThrow("REPOSITORY_BASE_UNAVAILABLE");
    }
  });
});
