import { expect, test } from "bun:test";
import { migrate } from "../../src/server/db/migrate.ts";
import { openDatabase } from "../../src/server/db/connection.ts";
import { createMemberRevocationAuthority } from "../../src/server/modules/identity/revocation.ts";

test("offboarding dispatches only after its durable revocation intent commits", async () => {
  const database = openDatabase(":memory:");
  migrate(database);
  database.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at)
      VALUES ('deployment_1', 1, 'team_1', 1, 0);
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at) VALUES
      ('owner_1', 'Ada', 'OWNER', 'ACTIVE', 1, 1, 0),
      ('member_1', 'Grace', 'MEMBER', 'ACTIVE', 1, 1, 0);
    INSERT INTO sessions(
      id, member_id, proof_hash, kind, expires_at, idle_expires_at, csrf_hash,
      absolute_expires_at, member_authority_epoch, revision, created_at
    ) VALUES ('owner_session', 'owner_1', X'${"11".repeat(32)}', 'BROWSER', 10000, 10000, X'${"12".repeat(32)}', 10000, 1, 1, 0);
  `);
  let dispatches = 0;
  const authority = createMemberRevocationAuthority({
    database,
    clock: () => 1_000,
    id: (prefix) => `${prefix}_${dispatches + 1}`,
    digest: async () => Uint8Array.from({ length: 32 }, () => 0x11),
    executionAuthority: {
      async execute() {
        expect(
          database
            .query<{ count: number }, []>(
              "SELECT count(*) AS count FROM authority_revocation_outbox",
            )
            .get(),
        ).toEqual({ count: 1 });
        dispatches += 1;
        return { ok: true, value: { applied: true } };
      },
    },
  });
  try {
    expect(
      (
        await authority.remove({
          idempotencyKey: "remove_1",
          actor: {
            kind: "MEMBER",
            memberId: "owner_1" as never,
            sessionId: "owner_session" as never,
            sessionProof: "proof-with-at-least-thirty-two-bytes",
          },
          memberId: "member_1" as never,
          expectedRevision: 1,
        })
      ).ok,
    ).toBe(true);
    expect(dispatches).toBe(1);
  } finally {
    database.close();
  }
});
