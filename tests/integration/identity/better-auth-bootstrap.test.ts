import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createBetterAuthBootstrapRoutes } from "../../../src/server/adapters/http/routes/better-auth-bootstrap.ts";
import { migrate } from "../../../src/server/db/migrate.ts";

const origin = "https://collab.example:8443";
const headers = {
  origin,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

describe("Better Auth bootstrap bridge", () => {
  test("does not claim a deployment until the registered passkey exists and completes once", async () => {
    const database = new Database(":memory:", { strict: true });
    migrate(database);
    let sequence = 0;
    const app = createBetterAuthBootstrapRoutes({
      database,
      configuredOrigin: origin,
      bootstrapSecret: "bootstrap-secret-with-at-least-thirty-two-bytes",
      clock: () => 1_000,
      id: (prefix) => `${prefix}_${++sequence}`,
      safeEqual: (left, right) => left === right,
    });
    const begin = await app.request("/bootstrap/auth/begin", {
      method: "POST",
      headers,
      body: JSON.stringify({
        bootstrapSecret: "bootstrap-secret-with-at-least-thirty-two-bytes",
        displayName: "Owner",
      }),
    });
    expect(begin.status).toBe(200);
    const begun = (await begin.json()) as {
      value: { registrationContext: string; memberId: string };
    };
    const complete = () =>
      app.request("/bootstrap/auth/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({
          registrationContext: begun.value.registrationContext,
        }),
      });
    expect((await complete()).status).toBe(400);
    expect(
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM deployments").get()
        ?.count,
    ).toBe(0);

    database
      .query(
        "UPDATE auth_registration_tickets SET state = 'PASSKEY_VERIFIED' WHERE auth_user_id = ?",
      )
      .run(begun.value.memberId);
    database
      .query(
        `INSERT INTO auth_passkeys(
           id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt
         ) VALUES ('passkey_1', 'Owner key', 'public', ?, 'credential_1', 0, 'multiDevice', 1, 1000000)`,
      )
      .run(begun.value.memberId);

    expect((await complete()).status).toBe(200);
    expect((await complete()).status).toBe(400);
    expect(
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM deployments").get()
        ?.count,
    ).toBe(1);
    expect(
      database
        .query<{ restore_state: string; revision: number }, []>(
          "SELECT restore_state, revision FROM deployment_authority_state",
        )
        .get(),
    ).toEqual({ restore_state: "READY", revision: 1 });
    expect(
      database
        .query<{ role: string }, [string]>("SELECT role FROM members WHERE id = ?")
        .get(begun.value.memberId)?.role,
    ).toBe("OWNER");
    const audits = database
      .query<{ kind: string; safe_details: string }, []>(
        `SELECT kind, safe_details FROM audit_events
         WHERE kind IN ('BOOTSTRAP_AUTH_BEGUN', 'BOOTSTRAP_AUTH_COMPLETED') ORDER BY created_at, kind`,
      )
      .all();
    expect(audits.map(({ kind }) => kind)).toEqual([
      "BOOTSTRAP_AUTH_BEGUN",
      "BOOTSTRAP_AUTH_COMPLETED",
    ]);
    expect(audits.every(({ safe_details }) => !safe_details.includes("bootstrap-secret"))).toBe(
      true,
    );
    database.close();
  });

  test("consumes a verified host-recovery ticket without revoking existing access", async () => {
    const database = new Database(":memory:", { strict: true });
    migrate(database);
    database.exec(`
      INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
      VALUES ('owner_1', 'Owner', 'OWNER', 'ACTIVE', 1, 1, 100);
      INSERT INTO auth_users(id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('auth_1', 'Owner', 'auth_1@identity.invalid', 0, 100000, 100000);
      INSERT INTO auth_member_links(auth_user_id, member_id, authority_epoch_snapshot, created_at)
      VALUES ('auth_1', 'owner_1', 1, 100);
      INSERT INTO auth_sessions(
        id, expiresAt, token, createdAt, updatedAt, userId, purpose,
        memberAuthorityEpoch, absoluteExpiresAt
      ) VALUES (
        'browser_existing', 2000000, 'existing-browser-token-with-at-least-thirty-two-characters',
        100000, 100000, 'auth_1', 'BROWSER', 1, 2000000
      );
      INSERT INTO auth_passkeys(
        id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt
      ) VALUES
        ('passkey_existing', 'Existing key', 'public', 'auth_1', 'credential_existing', 0, 'multiDevice', 1, 100000),
        ('passkey_recovery', 'Recovery key', 'public', 'auth_1', 'credential_recovery', 0, 'multiDevice', 1, 1000000);
    `);
    const registrationContext = "host-recovery-context-with-at-least-thirty-two-bytes";
    database
      .query(
        `INSERT INTO auth_registration_tickets(
           id, secret_hash, auth_user_id, intended_member_id, display_name,
           purpose, state, created_at, expires_at
         ) VALUES ('ticket_1', ?, 'auth_1', 'owner_1', 'Owner',
           'HOST_RECOVERY', 'PASSKEY_VERIFIED', 900, 1600)`,
      )
      .run(digestForTest(registrationContext));
    let sequence = 0;
    const app = createBetterAuthBootstrapRoutes({
      database,
      configuredOrigin: origin,
      bootstrapSecret: "bootstrap-secret-with-at-least-thirty-two-bytes",
      clock: () => 1_000,
      id: (prefix) => `${prefix}_${++sequence}`,
      safeEqual: (left, right) => left === right,
    });

    const complete = () =>
      app.request("/auth/recovery/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({ registrationContext }),
      });
    expect((await complete()).status).toBe(200);
    expect((await complete()).status).toBe(400);
    expect(
      database
        .query<{ state: string; consumed_at: number | null }, []>(
          "SELECT state, consumed_at FROM auth_registration_tickets WHERE id = 'ticket_1'",
        )
        .get(),
    ).toEqual({ state: "CONSUMED", consumed_at: 1_000 });
    expect(
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM auth_sessions").get()
        ?.count,
    ).toBe(1);
    expect(
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM auth_passkeys").get()
        ?.count,
    ).toBe(2);
    expect(
      database
        .query<{ safe_details: string }, []>(
          "SELECT safe_details FROM audit_events WHERE kind = 'HOST_RECOVERY_COMPLETED'",
        )
        .get()?.safe_details,
    ).toBe('{"disposition":"CONSUMED","passkeysPreserved":true,"sessionsPreserved":true}');
    database.close();
  });

  test("rejects cross-site bootstrap attempts", async () => {
    const database = new Database(":memory:", { strict: true });
    migrate(database);
    const app = createBetterAuthBootstrapRoutes({
      database,
      configuredOrigin: origin,
      bootstrapSecret: "bootstrap-secret-with-at-least-thirty-two-bytes",
      clock: () => 1_000,
      id: (prefix) => `${prefix}_1`,
      safeEqual: (left, right) => left === right,
    });
    expect(
      (
        await app.request("/bootstrap/auth/begin", {
          method: "POST",
          headers: { ...headers, "sec-fetch-site": "cross-site" },
          body: JSON.stringify({
            bootstrapSecret: "bootstrap-secret-with-at-least-thirty-two-bytes",
            displayName: "Owner",
          }),
        })
      ).status,
    ).toBe(403);
    database.close();
  });
});

function digestForTest(value: string): Uint8Array {
  return new Bun.CryptoHasher("sha256").update(value).digest();
}
