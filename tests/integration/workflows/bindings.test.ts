import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MemberActor } from "../../../src/shared/contracts/actors.ts";
import type { ExecutionAuthority } from "../../../src/shared/contracts/execution-authority.ts";
import type { MemberId, SessionId } from "../../../src/shared/contracts/ids.ts";
import type { PersonalWorkflowPreset } from "../../../src/shared/contracts/templates.ts";
import migration from "../../../src/server/db/migrations/0013_workflows.sql" with { type: "text" };
import { createWorkflowPresetRegistry } from "../../../src/server/modules/templates/workflow-presets.ts";

const actor = {
  kind: "MEMBER",
  memberId: "member_1" as MemberId,
  sessionId: "session_1" as SessionId,
  sessionProof: "x".repeat(32),
} as const satisfies MemberActor;
const preset: PersonalWorkflowPreset = {
  id: "workflow_preset_1",
  ownerMemberId: "member_1",
  version: 1,
  workflowTemplateVersionId: "workflow_review_v1",
  bindings: {
    implement: {
      personalRunPresetId: "claude_impl",
      expectedVersion: 3,
      repository: { repositoryId: "repository_1", intendedBranch: "collab/implement" },
    },
    review: {
      personalRunPresetId: "codex_review",
      expectedVersion: 7,
      repository: { repositoryId: "repository_1" },
    },
  },
  createdAt: 100,
};

function authorityWith(staleKeys: readonly string[]) {
  const executeCalls: unknown[] = [];
  const queries: unknown[] = [];
  const authority = {
    preview: async () => ({ evaluatedAt: 0, eligibleTargets: [], requirements: [] }),
    execute: async (command: unknown) => {
      executeCalls.push(command);
      throw new Error("UNEXPECTED_EXECUTE");
    },
    query: async (query: unknown) => {
      queries.push(query);
      return {
        ok: true,
        value: {
          kind: "RESOLVE_PERSONAL_RUN_PRESET_BINDINGS",
          staleKeys,
          bindings: {
            implement: {
              personalRunPresetId: "claude_impl",
              presetVersion: 3,
              runtime: "CLAUDE",
              runnerId: "runner_a",
              profileVersion: 2,
              host: "ORCA",
              interaction: "HEADLESS",
              repositoryMode: "MUTATING",
              repositoryAssurance: "ADVISORY",
              repository: preset.bindings.implement?.repository,
            },
            review: {
              personalRunPresetId: "codex_review",
              presetVersion: 7,
              runtime: "CODEX",
              runnerId: "runner_b",
              profileVersion: 5,
              host: "NATIVE",
              interaction: "INTERACTIVE",
              repositoryMode: "INSPECT_ONLY",
              repositoryAssurance: "ENFORCED",
              repository: preset.bindings.review?.repository,
            },
          },
        },
      };
    },
  } as unknown as ExecutionAuthority;
  return { authority, executeCalls, queries };
}

describe("Personal Workflow Preset exact bindings", () => {
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

  test("missing or stale bindings require an explicit replacement", async () => {
    const fake = authorityWith(["review"]);
    const registry = createWorkflowPresetRegistry({
      database,
      authority: fake.authority,
      clock: () => 100,
    });
    expect(await registry.bind({ idempotencyKey: "bind_1", actor, preset })).toMatchObject({
      ok: false,
      error: { code: "PRESET_BINDING_REQUIRED", retry: "EXPLICIT_RESUME" },
    });
    expect(fake.executeCalls).toHaveLength(0);
  });

  test("snapshots distinct exact runtime bindings without substitution", async () => {
    const fake = authorityWith([]);
    const registry = createWorkflowPresetRegistry({
      database,
      authority: fake.authority,
      clock: () => 100,
    });
    const result = await registry.bind({ idempotencyKey: "bind_1", actor, preset });
    expect(result).toMatchObject({ ok: true, value: { id: "workflow_preset_1", version: 1 } });
    expect(fake.queries).toEqual([
      { kind: "RESOLVE_PERSONAL_RUN_PRESET_BINDINGS", actor, bindings: preset.bindings },
    ]);
    expect(
      JSON.parse(
        database
          .query<{ bindings_json: string }, []>(
            "SELECT bindings_json FROM personal_workflow_presets",
          )
          .get()?.bindings_json ?? "null",
      ),
    ).toEqual(preset.bindings);
    expect(fake.executeCalls).toHaveLength(0);
  });
});
