import { expect, test } from "bun:test";
import { createProjectionCodec } from "../../../src/server/modules/connectors/contract.ts";
import { GitHubProjectionSchema } from "../../../src/shared/contracts/github.ts";

test("GitHub projection codec refuses source bodies and raw provider payloads", () => {
  const codec = createProjectionCodec(GitHubProjectionSchema);
  expect(
    codec.serialize({
      kind: "ISSUE",
      repositoryId: "1",
      number: 1,
      title: "x",
      state: "OPEN",
      labels: [],
      assignees: [],
      body: "secret",
    } as never).ok,
  ).toBe(false);
  expect(codec.serialize({ kind: "RAW", payload: { body: "secret" } } as never).ok).toBe(false);
});
