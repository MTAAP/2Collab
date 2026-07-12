import { expect, test } from "bun:test";
import { createGitHubDurableWorker } from "../../../src/server/modules/github-coordination/durable-worker.ts";
import { coordinationFixture } from "../coordination-records/fixture.ts";

test("durable GitHub worker resumes pending webhook application and persisted cursor after restart", async () => {
  const database = coordinationFixture();
  database.exec(`
    INSERT INTO github_project_connectors(project_id, connector_id, revision, created_at)
      VALUES ('project_1', 'github_1', 1, 0);
    INSERT INTO github_webhook_deliveries(connector_id, hook_id, delivery_id, event_name, payload_digest, ingress_state, received_at)
      VALUES ('github_1', 'hook_1', 'delivery_1', 'issues', '${"a".repeat(64)}', 'VERIFIED', 0);
    INSERT INTO github_webhook_applications(connector_id, hook_id, delivery_id, project_id, outcome, revision)
      VALUES ('github_1', 'hook_1', 'delivery_1', 'project_1', 'PENDING', 1);
    INSERT INTO github_reconciliation_cursors(project_id, connector_id, resource_family, scope_digest, connector_epoch, cursor, status, revision)
      VALUES ('project_1', 'github_1', 'REPOSITORIES', '${"b".repeat(64)}', 1, '{"page":2}', 'FAILED_RETRYABLE', 1);
  `);
  const resumed: Array<string | undefined> = [];
  const worker = createGitHubDurableWorker({
    database,
    clock: () => 100,
    scope: (projectId, connectorId) => ({
      ok: true,
      value: {
        projectId: projectId as never,
        connectorId: connectorId as never,
        connectorEpoch: 1,
        references: ["REPOSITORY:101"],
        operations: ["CREATE_ISSUE"],
      },
    }),
    reconcile: async (_scope, cursor, onProgress) => {
      resumed.push(cursor);
      onProgress('{"page":3}');
      return { ok: true, value: {} };
    },
  });

  expect(await worker.consumePendingWebhookApplications()).toMatchObject({
    ok: true,
    value: { applied: 1 },
  });
  expect(
    database.query<{ outcome: string }, []>("SELECT outcome FROM github_webhook_applications").get()
      ?.outcome,
  ).toBe("APPLIED");
  expect(await worker.runDueReconciliation()).toMatchObject({ ok: true, value: { completed: 1 } });
  expect(resumed).toEqual([undefined, '{"page":2}']);
  expect(
    database
      .query<{ cursor: string | null; status: string }, []>(
        "SELECT cursor, status FROM github_reconciliation_cursors",
      )
      .get(),
  ).toEqual({ cursor: null, status: "IDLE" });
  database.close();
});
