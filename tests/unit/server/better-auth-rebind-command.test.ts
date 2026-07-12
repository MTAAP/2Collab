import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createBetterAuthRebindCommand } from "../../../src/server/commands/better-auth-rebind.ts";
import { migrate } from "../../../src/server/db/migrate.ts";

test("host-controlled rebind creates one expiring fragment-only registration context", () => {
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  database.exec(`
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
    VALUES ('owner_1', 'Owner', 'OWNER', 'ACTIVE', 1, 1, 100);
    INSERT INTO auth_users(id, name, email, emailVerified, createdAt, updatedAt)
    VALUES ('owner_1', 'Owner', 'owner_1@identity.invalid', 0, 100000, 100000);
    INSERT INTO auth_member_links(auth_user_id, member_id, authority_epoch_snapshot, created_at)
    VALUES ('owner_1', 'owner_1', 1, 100);
  `);
  const command = createBetterAuthRebindCommand({
    database,
    invocationMode: "OFFLINE_CONTAINER",
    mountedBootstrapSecret: "mounted-bootstrap-secret-with-at-least-thirty-two-bytes",
    publicBaseUrl: "https://collab.example:8443",
    clock: () => 1_000,
    id: () => "ticket_1",
    randomSecret: () => "registration-context-with-at-least-thirty-two-bytes",
  });
  const result = command.generate({ memberId: "owner_1" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  expect(result.value.recoveryUrl).toBe(
    "https://collab.example:8443/recover#registration-context-with-at-least-thirty-two-bytes",
  );
  expect(result.value.recoveryUrl.split("#", 1)[0]).not.toContain("registration-context");
  expect(
    database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM auth_registration_tickets")
      .get()?.count,
  ).toBe(1);
  expect(
    database
      .query<{ safe_details: string }, []>(
        "SELECT safe_details FROM audit_events WHERE kind = 'HOST_RECOVERY_GENERATED'",
      )
      .get()?.safe_details,
  ).toBe('{"disposition":"GENERATED","expiresInSeconds":600}');
  database.close();
});
