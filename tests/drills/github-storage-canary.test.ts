import { expect, test } from "bun:test";
import { GitHubProjectionSchema } from "../../src/shared/contracts/github.ts";
import type { GitHubProjection } from "../../src/shared/contracts/github.ts";
import { createProjectionCodec } from "../../src/server/modules/connectors/contract.ts";
import { coordinationFixture } from "../integration/coordination-records/fixture.ts";

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

  const database = coordinationFixture();
  database.exec(`
    INSERT INTO github_project_connectors(project_id, connector_id, revision, created_at)
      VALUES ('project_1', 'github_1', 1, 0);
    INSERT INTO github_selected_repositories(project_id, connector_id, repository_id, repository_node_id, owner_login, name, permission_digest, scope_state, revision, created_at, updated_at)
      VALUES ('project_1', 'github_1', '101', 'R_101', 'owner', 'repo', '${"a".repeat(64)}', 'SELECTED', 1, 0, 0);
    INSERT INTO github_source_projections(project_id, connector_id, repository_id, source_kind, source_id, projection_schema_version, projection_json, projection_hash, source_revision, comparable_digest, observed_at, provenance_kind, freshness, revision)
      VALUES ('project_1', 'github_1', '101', 'ISSUE', 'ISSUE:101:42', 1, '${encoded.ok ? encoded.value.replaceAll("'", "''") : "{}"}', '${"b".repeat(64)}', 'v1', '${"c".repeat(64)}', 1, 'RECONCILIATION', 'FRESH', 1);
  `);
  const completeStoreImage = Buffer.from(database.serialize()).toString("latin1");
  for (const canary of prohibited) expect(completeStoreImage).not.toContain(canary);
  database.close();
});
