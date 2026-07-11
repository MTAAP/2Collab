import { expect, test } from "bun:test";
import { GitHubProjectionSchema } from "../../src/shared/contracts/github.ts";
import type { GitHubProjection } from "../../src/shared/contracts/github.ts";
import { createProjectionCodec } from "../../src/server/modules/connectors/contract.ts";

test("GitHub durable projection channels reject prohibited storage canaries", () => {
  const prohibited = [
    `raw-body-${crypto.randomUUID()}`,
    `provider-error-${crypto.randomUUID()}`,
    `installation-token-${crypto.randomUUID()}`,
    `/private/${crypto.randomUUID()}`,
    ["C:", "private", crypto.randomUUID()].join(String.fromCharCode(92)),
  ];
  const projection: GitHubProjection = {
    kind: "ISSUE",
    repositoryId: "101",
    number: 42,
    title: "Safe title",
    state: "OPEN",
    labels: [],
    assignees: [],
    commentCount: 1,
  };
  const codec = createProjectionCodec(GitHubProjectionSchema);
  const encoded = codec.serialize(projection);
  expect(encoded.ok).toBe(true);
  const durable = encoded.ok ? encoded.value : "";
  for (const canary of prohibited) expect(durable).not.toContain(canary);
  for (const key of [
    "body",
    "rawWebhook",
    "providerError",
    "installationToken",
    "rawDiff",
    "absolutePath",
  ])
    expect(codec.serialize({ ...projection, [key]: prohibited[0] } as never).ok).toBe(false);
});
