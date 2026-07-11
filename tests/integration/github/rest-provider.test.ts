import { expect, test } from "bun:test";
import { createGitHubRestProvider } from "../../../src/server/adapters/github/rest-provider.ts";

const scope = {
  projectId: "project_1" as never,
  connectorId: "github_1" as never,
  connectorEpoch: 1,
  references: ["REPOSITORY:101"],
  operations: ["CREATE_ISSUE"],
};
const issue = {
  id: 9001,
  number: 42,
  title: "Issue",
  state: "open",
  state_reason: null,
  labels: [],
  assignees: [],
  milestone: null,
  comments: 0,
  updated_at: "2026-07-11T12:00:00Z",
};

test("production REST provider uses fixed endpoints and returns bounded normalized projections", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const provider = createGitHubRestProvider({
    connectorId: "github_1",
    clock: () => 1,
    selectedRepositoryIds: () => ["101"],
    selectedProjectIds: () => [],
    token: async () => ({ ok: true, value: "installation-secret" }),
    repository: () => ({
      ok: true,
      value: { repositoryId: "101", owner: "owner", name: "repo", nodeId: "R_101" },
    }),
    fetcher: async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify(issue), { status: 200 });
    },
  });
  const inspected = await provider.inspect(scope, {
    kind: "ISSUE",
    repositoryId: "101",
    number: 42,
  });
  expect(inspected).toMatchObject({
    ok: true,
    value: { value: { kind: "ISSUE", title: "Issue" } },
  });
  const mutation = {
    kind: "CREATE_ISSUE" as const,
    repository: { kind: "REPOSITORY" as const, repositoryId: "101" },
    title: "Issue",
    body: "source body",
  };
  const actionDigest = "a".repeat(64) as never;
  const created = await provider.mutate(
    {
      kind: "CONNECTOR_OPERATION",
      id: "authorization_1",
      proof: "p".repeat(32),
      projectId: scope.projectId,
      connectorId: scope.connectorId,
      connectorEpoch: 1,
      reference: "REPOSITORY:101",
      operation: "CREATE_ISSUE",
      actionDigest,
      expiresAt: 100,
    },
    {
      projectId: scope.projectId,
      connectorId: scope.connectorId,
      connectorEpoch: 1,
      idempotencyKey: "create_1",
      precondition: { kind: "ABSENT" },
      actionDigest,
      mutation,
    },
  );
  expect(created).toMatchObject({ ok: true, value: { reference: "ISSUE:101:42" } });
  expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
    "GET /repos/owner/repo/issues/42",
    "POST /repos/owner/repo/issues",
  ]);
  expect(JSON.stringify(created)).not.toContain("source body");
  expect(JSON.stringify(created)).not.toContain("installation-secret");
});
