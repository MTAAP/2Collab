import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import migration from "../../../src/server/db/migrations/0013_workflows.sql" with { type: "text" };
import { createWorkflowDraftStore } from "../../../src/server/modules/workflows/drafts.ts";
import {
  exportWorkflowYaml,
  importWorkflowYaml,
} from "../../../src/server/modules/workflows/yaml.ts";
import { validDefinition, validLayout } from "../../fixtures/workflows/valid.ts";

describe("shared Workflow Drafts", () => {
  let database: Database;

  beforeEach(() => {
    database = new Database(":memory:", { strict: true });
    database.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
    );
    for (let version = 1; version <= 12; version += 1)
      database.query("INSERT INTO schema_migrations VALUES (?, 0)").run(version);
    database.exec(migration);
  });
  afterEach(() => database.close());

  test("a stale save cannot overwrite another member", () => {
    const drafts = createWorkflowDraftStore({ database, clock: () => 100, id: () => "draft_copy" });
    const base = {
      idempotencyKey: "create_1",
      actorMemberId: "member_1",
      draftId: "draft_1",
      templateKey: "review_flow",
      expectedRevision: 0,
      definition: validDefinition,
      layout: validLayout,
    } as const;
    expect(drafts.save(base)).toMatchObject({ ok: true, value: { revision: 1 } });
    expect(drafts.save({ ...base, idempotencyKey: "save_2", expectedRevision: 1 })).toMatchObject({
      ok: true,
      value: { revision: 2 },
    });
    expect(
      drafts.save({ ...base, idempotencyKey: "save_stale", expectedRevision: 1 }),
    ).toMatchObject({
      ok: false,
      error: { code: "WORKFLOW_DRAFT_REVISION_STALE" },
    });
  });

  test("duplicates a stale draft without overwriting it", () => {
    const drafts = createWorkflowDraftStore({ database, clock: () => 100, id: () => "draft_copy" });
    drafts.save({
      idempotencyKey: "create_1",
      actorMemberId: "member_1",
      draftId: "draft_1",
      templateKey: "review_flow",
      expectedRevision: 0,
      definition: validDefinition,
      layout: validLayout,
    });
    const command = {
      idempotencyKey: "duplicate_1",
      actorMemberId: "member_2",
      draftId: "draft_1",
    } as const;
    expect(drafts.duplicate(command)).toMatchObject({
      ok: true,
      value: { id: "draft_copy", revision: 1, updatedByMemberId: "member_2" },
    });
    expect(drafts.duplicate(command)).toMatchObject({
      ok: true,
      value: { id: "draft_copy", revision: 1, updatedByMemberId: "member_2" },
    });
    expect(
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM workflow_drafts").get()
        ?.count,
    ).toBe(2);
  });

  test("YAML round-trips only the executable schema", () => {
    expect(importWorkflowYaml(exportWorkflowYaml(validDefinition))).toEqual(validDefinition);
  });

  test.each([
    ["personalRunPresetId: private\n"],
    ["reactFlowNodes: []\n"],
    ["nodes:\n  - kind: AGENT_RUN\n    key: review\n    runnerId: private\n"],
  ])("YAML import rejects private or presentation data", (source) => {
    expect(() => importWorkflowYaml(source)).toThrow("WORKFLOW_IMPORT_PRIVATE_DATA");
  });
});
