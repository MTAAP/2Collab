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
    workItemNodeId: () => ({ ok: true, value: "I_42" }),
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

test("Projects paginate fields and items, refresh eligibility, and use the clear-field mutation", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const provider = createGitHubRestProvider({
    connectorId: "github_1",
    clock: () => 1,
    selectedRepositoryIds: () => ["101"],
    selectedProjectIds: () => ["PVT_1"],
    token: async () => ({ ok: true, value: "installation-secret" }),
    repository: () => ({
      ok: true,
      value: { repositoryId: "101", owner: "owner", name: "repo", nodeId: "R_101" },
    }),
    workItemNodeId: () => ({ ok: true, value: "I_42" }),
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      requests.push(body);
      if (body.query.includes("clearProjectV2ItemFieldValue"))
        return Response.json({
          data: { clearProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } },
        });
      if (body.query.includes("ProjectFields")) {
        const second = body.variables.after === "field_cursor";
        return Response.json({
          data: {
            node: {
              id: "PVT_1",
              title: "Roadmap",
              fields: {
                nodes: second
                  ? [{ id: "PVTF_2", name: "Notes", dataType: "TEXT" }]
                  : [
                      {
                        id: "PVTF_1",
                        name: "Status",
                        dataType: "SINGLE_SELECT",
                        options: [{ id: "OPT_1" }],
                      },
                    ],
                pageInfo: { hasNextPage: !second, endCursor: second ? null : "field_cursor" },
              },
            },
          },
        });
      }
      return Response.json({
        data: {
          node: {
            items: {
              nodes: [{ id: "PVTI_1", content: { number: 42, repository: { databaseId: 101 } } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    },
  });
  const projectScope = {
    ...scope,
    references: ["PROJECT:PVT_1"],
    operations: ["SET_PROJECT_FIELD"],
  };
  const inspected = await provider.inspect(projectScope, {
    kind: "PROJECT",
    projectNodeId: "PVT_1",
  });
  if (!inspected.ok) throw new Error(inspected.error.code);
  expect(inspected.value.value).toMatchObject({
    kind: "PROJECT",
    itemCount: 1,
    fields: [{ id: "PVTF_1" }, { id: "PVTF_2" }],
  });
  const actionDigest = "c".repeat(64) as never;
  const cleared = await provider.mutate(
    {
      kind: "CONNECTOR_OPERATION",
      id: "authorization_2",
      proof: "p".repeat(32),
      projectId: projectScope.projectId,
      connectorId: projectScope.connectorId,
      connectorEpoch: 1,
      reference: "PROJECT:PVT_1",
      operation: "SET_PROJECT_FIELD",
      actionDigest,
      expiresAt: 100,
    },
    {
      projectId: projectScope.projectId,
      connectorId: projectScope.connectorId,
      connectorEpoch: 1,
      idempotencyKey: "clear_1",
      precondition: {
        kind: "EXACT_REVISION",
        sourceRevision: inspected.value.sourceRevision,
        comparableDigest: inspected.value.comparableDigest,
      },
      actionDigest,
      mutation: {
        kind: "SET_PROJECT_FIELD",
        project: { kind: "PROJECT", projectNodeId: "PVT_1" },
        itemId: "PVTI_1",
        fieldId: "PVTF_1",
        value: { kind: "CLEAR" },
      },
    },
  );
  expect(cleared.ok).toBe(true);
  const clear = requests.find((entry) => entry.query.includes("clearProjectV2ItemFieldValue"));
  expect(clear?.variables).toEqual({ project: "PVT_1", item: "PVTI_1", field: "PVTF_1" });
});
