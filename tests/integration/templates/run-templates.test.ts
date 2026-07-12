import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import migration from "../../../src/server/db/migrations/0013_workflows.sql" with { type: "text" };
import { createTemplateRegistry } from "../../../src/server/modules/templates/versioning.ts";
import { portableRunTemplate } from "../../unit/templates/portable-template.test.ts";

describe("Team Run Template registry", () => {
  let database: Database;

  beforeEach(() => {
    database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
      ${Array.from({ length: 12 }, (_, index) => `INSERT INTO schema_migrations VALUES (${index + 1}, 0);`).join("\n")}
      CREATE TABLE members(id TEXT PRIMARY KEY, status TEXT NOT NULL) STRICT;
      INSERT INTO members VALUES ('member_1', 'ACTIVE');
    `);
    database.exec(migration);
  });

  afterEach(() => database.close());

  test("publishes immutable versions and preserves prior bytes", async () => {
    const registry = createTemplateRegistry({
      database,
      clock: () => 100,
      id: (prefix) => `${prefix}_1`,
    });
    const first = await registry.publishRunTemplate({
      idempotencyKey: "publish_1",
      actorMemberId: "member_1",
      templateKey: "review",
      expectedVersion: 0,
      definition: portableRunTemplate,
    });
    expect(first.ok).toBe(true);
    const bytes = database
      .query<{ definition_json: string }, []>(
        "SELECT definition_json FROM team_run_template_versions WHERE version = 1",
      )
      .get()?.definition_json;
    const second = await registry.publishRunTemplate({
      idempotencyKey: "publish_2",
      actorMemberId: "member_1",
      templateKey: "review",
      expectedVersion: 1,
      definition: { ...portableRunTemplate, description: "Second version" },
    });
    expect(second).toMatchObject({ ok: true, value: { version: 2 } });
    expect(
      database
        .query<{ definition_json: string }, []>(
          "SELECT definition_json FROM team_run_template_versions WHERE version = 1",
        )
        .get()?.definition_json,
    ).toBe(bytes);
  });

  test("replays one idempotency key and rejects stale versions", async () => {
    const registry = createTemplateRegistry({
      database,
      clock: () => 100,
      id: (prefix) => `${prefix}_1`,
    });
    const command = {
      idempotencyKey: "publish_1",
      actorMemberId: "member_1",
      templateKey: "review",
      expectedVersion: 0,
      definition: portableRunTemplate,
    } as const;
    expect(await registry.publishRunTemplate(command)).toEqual(
      await registry.publishRunTemplate(command),
    );
    expect(
      await registry.publishRunTemplate({ ...command, idempotencyKey: "publish_2" }),
    ).toMatchObject({
      ok: false,
      error: { code: "TEMPLATE_VERSION_CONFLICT" },
    });
  });
});
