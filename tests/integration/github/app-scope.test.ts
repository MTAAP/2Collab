import { describe, expect, test } from "bun:test";
import { assertGitHubScope } from "../../../src/server/adapters/github/scope.ts";
import { StrictGitHubAdapter } from "../../fixtures/github/strict-github-adapter.ts";
import {
  GitHubInstallationTokenCache,
  requestInstallationToken,
} from "../../../src/server/adapters/github/app-auth.ts";

const scope = {
  projectId: "project_1" as never,
  connectorId: "github_1" as never,
  connectorEpoch: 3,
  references: ["REPOSITORY:101", "PROJECT:PVT_1"],
  operations: ["INSPECT_PROJECT", "EDIT_ISSUE"],
};

describe("GitHub App scope ceiling", () => {
  test("redacts an organization Project item from an unselected repository", async () => {
    const github = StrictGitHubAdapter.seed({
      connectorId: "github_1",
      connectorEpoch: 3,
      selectedRepositoryIds: ["101"],
      providerRepositoryIds: ["101", "202"],
      selectedProjectIds: ["PVT_1"],
    });
    github.addProjectItem("PVT_1", {
      itemId: "PVTI_9",
      repositoryId: "202",
      number: 9,
      title: "secret",
    });
    const result = await github.inspect(scope, { kind: "PROJECT", projectNodeId: "PVT_1" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.value).toEqual(
      expect.objectContaining({ unsupportedRepositoryItems: 1 }),
    );
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("denies scope disagreement and stale epochs", () => {
    expect(
      assertGitHubScope({
        connectorId: "github_1",
        connectorEpoch: 3,
        expectedConnectorEpoch: 3,
        selectedRepositoryIds: new Set(["101"]),
        providerRepositoryIds: new Set(["101", "202"]),
        selectedProjectIds: new Set(["PVT_1"]),
        repositoryId: "202",
      }),
    ).toMatchObject({ ok: false, error: { code: "GITHUB_REPOSITORY_NOT_SELECTED" } });
    expect(
      assertGitHubScope({
        connectorId: "github_1",
        connectorEpoch: 2,
        expectedConnectorEpoch: 3,
        selectedRepositoryIds: new Set(["101"]),
        providerRepositoryIds: new Set(["101"]),
        selectedProjectIds: new Set(),
        repositoryId: "101",
      }),
    ).toMatchObject({ ok: false, error: { code: "CONNECTOR_REVOKED" } });
  });

  test("scope narrowing invalidates an in-flight fixture call", async () => {
    const github = StrictGitHubAdapter.seed({
      connectorId: "github_1",
      connectorEpoch: 3,
      selectedRepositoryIds: ["101"],
      providerRepositoryIds: ["101"],
      selectedProjectIds: [],
    });
    github.addIssue({ repositoryId: "101", number: 1, title: "Allowed" });
    github.beforeNextConfirmation(() => github.narrowScope({ repositoryIds: [], connectorEpoch: 4 }));
    const result = await github.inspect(scope, { kind: "ISSUE", repositoryId: "101", number: 1 });
    expect(result).toMatchObject({ ok: false, error: { code: "CONNECTOR_REVOKED" } });
  });

  test("requests an in-memory token with the exact selected repositories and permissions", async () => {
    let requestBody = "";
    const result = await requestInstallationToken({
      appJwt: "signed-jwt",
      installationId: "123",
      repositoryIds: ["101"],
      permissions: { issues: "write", contents: "read" },
      fetcher: async (_url, init) => {
        requestBody = String(init?.body);
        return new Response(
          JSON.stringify({ token: "installation-token", expires_at: "2030-01-01T00:00:00Z" }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(requestBody)).toEqual({
      repository_ids: ["101"],
      permissions: { issues: "write", contents: "read" },
    });
    expect(JSON.stringify(result)).not.toContain("signed-jwt");
  });

  test("installation token cache is fenced by connector epoch and scope digests", async () => {
    const cache = new GitHubInstallationTokenCache();
    let issued = 0;
    const get = (connectorEpoch: number) =>
      cache.get({
        connectorId: "github_1",
        connectorEpoch,
        scopeDigest: "scope-a",
        permissionDigest: "permission-a",
        now: 1_000,
        issue: async () => {
          issued += 1;
          return { ok: true as const, value: { token: `token-${issued}`, expiresAt: 100_000, repositoryIds: ["101"], permissions: { issues: "write" as const } } };
        },
      });
    await get(3);
    await get(3);
    await get(4);
    expect(issued).toBe(2);
  });
});
