import { expect, test } from "bun:test";
import { bindGitHubMutationClient } from "../../src/server/adapters/mcp/github-tools.ts";
import { performGitHubMutation } from "../../src/server/modules/github-coordination/mutations.ts";
import { actor, command, fixture, observedIssue } from "../integration/github/mutation-fixture.ts";

test("HTTP and MCP translations consume the same GitHub command service", async () => {
  const first = fixture();
  const current = await observedIssue(first.github);
  const request = command(
    {
      kind: "SET_LABELS",
      issue: { kind: "ISSUE", repositoryId: "101", number: 1 },
      labels: ["ready"],
    },
    {
      kind: "EXACT_REVISION",
      sourceRevision: current.sourceRevision,
      comparableDigest: current.comparableDigest,
    },
  );
  const service = (f: ReturnType<typeof fixture>) => (value: typeof request) =>
    performGitHubMutation({
      github: f.github,
      connectorAuthority: f.authority,
      authorized: { authorityKind: "MEMBER", actor, command: value },
    });
  const httpResult = await service(first)(request);
  const second = fixture();
  const mcp = bindGitHubMutationClient(service(second));
  const mcpResult = await mcp.mutate(request);
  if (mcpResult.ok && httpResult.ok) {
    expect(mcpResult.value.observedAt).toBeGreaterThanOrEqual(httpResult.value.observedAt);
    expect({ ...mcpResult.value, observedAt: 0 }).toEqual({
      ...httpResult.value,
      observedAt: 0,
    });
  } else expect(mcpResult).toEqual(httpResult);
});
