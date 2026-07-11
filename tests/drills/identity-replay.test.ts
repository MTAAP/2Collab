import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { openDatabase } from "../../src/server/db/connection.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import { IdentityIdempotency } from "../../src/server/modules/identity/idempotency.ts";

describe("identity replay security", () => {
  test("same identity command replays safely while changed input conflicts", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    try {
      const idempotency = new IdentityIdempotency(
        database,
        async (value) => createHash("sha256").update(value).digest(),
        () => 1_000,
      );
      const first = await idempotency.ticket("IDENTITY_DRILL", "member_1", "replay_1", {
        revision: 1,
      });
      if (!first.ok) throw new Error(first.error.code);
      idempotency.storeResult(first.value, { ok: true, value: { revision: 2 } });
      expect(idempotency.replay(first.value, z.object({ revision: z.number() }))).toEqual({
        ok: true,
        value: { revision: 2 },
      });
      const changed = await idempotency.ticket("IDENTITY_DRILL", "member_1", "replay_1", {
        revision: 2,
      });
      if (!changed.ok) throw new Error(changed.error.code);
      expect(idempotency.replay(changed.value, z.object({ revision: z.number() }))).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_CONFLICT" },
      });
    } finally {
      database.close();
    }
  });

  test("secret-producing identity replay stores only a bounded marker", async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    try {
      const idempotency = new IdentityIdempotency(
        database,
        async (value) => createHash("sha256").update(value).digest(),
        () => 1_000,
      );
      const ticket = await idempotency.ticket("INVITATION_SECRET", "owner_1", "secret_1", {
        member: "member_1",
      });
      if (!ticket.ok) throw new Error(ticket.error.code);
      const canary = "invitation-cleartext-never-store";
      idempotency.storeSecretIssued(
        ticket.value,
        "INVITATION_ALREADY_ISSUED",
        "Invitation secret was already issued.",
      );
      const stored = database
        .query<{ result_json: string }, []>("SELECT result_json FROM idempotency_results")
        .get();
      expect(stored?.result_json).not.toContain(canary);
      expect(idempotency.replay(ticket.value)).toMatchObject({
        ok: false,
        error: { code: "INVITATION_ALREADY_ISSUED" },
      });
    } finally {
      database.close();
    }
  });
});
