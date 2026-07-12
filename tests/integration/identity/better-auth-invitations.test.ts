import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createBetterAuthInvitationRoutes } from "../../../src/server/adapters/http/routes/better-auth-invitations.ts";
import { migrate } from "../../../src/server/db/migrate.ts";

const ORIGIN = "https://collab.example:8443";
const INVITATION_SECRET = "invitation-secret-with-at-least-thirty-two-bytes";
const EXCHANGE_SECRET = "exchange-secret-with-at-least-thirty-two-bytes";
const headers = {
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

function fixture() {
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  database.exec(`
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
    VALUES ('member_owner', 'Owner', 'OWNER', 'ACTIVE', 1, 1, 100);
    INSERT INTO invitations(id, token_hash, inviter_id, label, expires_at, revision, created_at)
    VALUES ('invitation_1', x'${digest(INVITATION_SECRET).toString("hex")}', 'member_owner', 'Teammate', 2000, 1, 100);
  `);
  let sequence = 0;
  const app = createBetterAuthInvitationRoutes({
    database,
    configuredOrigin: ORIGIN,
    clock: () => 1_000,
    id: (prefix) => `${prefix}_${++sequence}`,
    async exchangeInvitation(input) {
      if (input.secret !== INVITATION_SECRET)
        return {
          ok: false as const,
          error: {
            code: "INVITATION_INVALID",
            message: "Invitation is invalid.",
            retry: "NEVER" as const,
          },
        };
      database
        .query(
          `INSERT INTO invitation_exchange_sessions(
             id, invitation_id, session_hash, revision, created_at, expires_at
           ) VALUES ('exchange_1', 'invitation_1', ?, 1, 1000, 1900)`,
        )
        .run(digest(EXCHANGE_SECRET));
      return {
        ok: true as const,
        value: { invitationId: "invitation_1", secret: EXCHANGE_SECRET, expiresAt: 1_900 },
      };
    },
  });
  return { app, database };
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("SET_COOKIE_MISSING");
  return setCookie.split(";", 1)[0] ?? "";
}

describe("Better Auth invitation bridge", () => {
  test("provisions an unlinked identity and creates the member only after verified passkey completion", async () => {
    const value = fixture();
    const exchange = await value.app.request("/invitations/exchange", {
      method: "POST",
      headers,
      body: JSON.stringify({ secret: INVITATION_SECRET, idempotencyKey: "exchange_1" }),
    });
    expect(exchange.status).toBe(200);
    expect(exchange.headers.get("set-cookie")).toContain("Path=/api/v1/invitations");
    const cookie = cookieFrom(exchange);

    const begin = await value.app.request("/invitations/auth/begin", {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify({ displayName: "Invitee" }),
    });
    expect(begin.status).toBe(200);
    const begun = (await begin.json()) as {
      value: { registrationContext: string; memberId: string; invitation: { role: string } };
    };
    expect(begun.value.invitation.role).toBe("MEMBER");
    expect(
      value.database.query<{ count: number }, []>("SELECT count(*) AS count FROM members").get()
        ?.count,
    ).toBe(1);
    expect(
      value.database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM auth_member_links")
        .get()?.count,
    ).toBe(0);

    const complete = () =>
      value.app.request("/invitations/auth/complete", {
        method: "POST",
        headers: { ...headers, cookie },
        body: JSON.stringify({ registrationContext: begun.value.registrationContext }),
      });
    expect((await complete()).status).toBe(400);

    value.database
      .query(
        "UPDATE auth_registration_tickets SET state = 'PASSKEY_VERIFIED' WHERE auth_user_id = ?",
      )
      .run(begun.value.memberId);
    value.database
      .query(
        `INSERT INTO auth_passkeys(
           id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt
         ) VALUES ('passkey_invitee', 'Invitee key', 'public', ?, 'credential_invitee', 0,
                   'multiDevice', 1, 1000000)`,
      )
      .run(begun.value.memberId);

    const completed = await complete();
    expect(completed.status).toBe(200);
    expect(completed.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await completed.json()) as unknown).toEqual({
      ok: true,
      value: { memberId: begun.value.memberId, readyToSignIn: true },
    });
    expect((await complete()).status).toBe(403);
    expect(
      value.database
        .query<{ role: string; status: string }, [string]>(
          "SELECT role, status FROM members WHERE id = ?",
        )
        .get(begun.value.memberId),
    ).toEqual({ role: "MEMBER", status: "ACTIVE" });
    expect(
      value.database
        .query<{ member_id: string }, [string]>(
          "SELECT member_id FROM auth_member_links WHERE auth_user_id = ?",
        )
        .get(begun.value.memberId)?.member_id,
    ).toBe(begun.value.memberId);
    expect(
      value.database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM audit_events WHERE kind IN ('INVITATION_AUTH_BEGUN', 'INVITATION_AUTH_COMPLETED')",
        )
        .get()?.count,
    ).toBe(2);
    expect(
      value.database
        .query<{ count: number }, [string]>(
          `SELECT count(*) AS count FROM audit_events
           WHERE safe_details LIKE '%' || ? || '%'`,
        )
        .get(begun.value.registrationContext)?.count,
    ).toBe(0);
    value.database.close();
  });

  test("rejects missing invitation cookies and cross-site registration", async () => {
    const value = fixture();
    const body = JSON.stringify({ displayName: "Invitee" });
    expect(
      (await value.app.request("/invitations/auth/begin", { method: "POST", headers, body }))
        .status,
    ).toBe(403);
    expect(
      (
        await value.app.request("/invitations/auth/begin", {
          method: "POST",
          headers: {
            ...headers,
            "sec-fetch-site": "cross-site",
            cookie: `collab_invitation=${EXCHANGE_SECRET}`,
          },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      value.database.query<{ count: number }, []>("SELECT count(*) AS count FROM auth_users").get()
        ?.count,
    ).toBe(0);
    value.database.close();
  });

  test("rolls back ticket and exchange consumption when the invitation CAS misses", async () => {
    const value = fixture();
    const exchange = await value.app.request("/invitations/exchange", {
      method: "POST",
      headers,
      body: JSON.stringify({ secret: INVITATION_SECRET, idempotencyKey: "exchange_rollback" }),
    });
    const cookie = cookieFrom(exchange);
    const begin = await value.app.request("/invitations/auth/begin", {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify({ displayName: "Invitee" }),
    });
    const begun = (await begin.json()) as {
      value: { registrationContext: string; memberId: string };
    };
    value.database
      .query(
        "UPDATE auth_registration_tickets SET state = 'PASSKEY_VERIFIED' WHERE auth_user_id = ?",
      )
      .run(begun.value.memberId);
    value.database
      .query(
        `INSERT INTO auth_passkeys(
           id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt
         ) VALUES ('passkey_rollback', 'Invitee key', 'public', ?, 'credential_rollback', 0,
                   'multiDevice', 1, 1000000)`,
      )
      .run(begun.value.memberId);
    value.database.exec(`
      CREATE TRIGGER force_invitation_cas_miss
      AFTER UPDATE OF consumed_at ON invitation_exchange_sessions
      WHEN NEW.id = 'exchange_1'
      BEGIN
        UPDATE invitations SET revoked_at = 1000 WHERE id = NEW.invitation_id;
      END;
    `);

    const completed = await value.app.request("/invitations/auth/complete", {
      method: "POST",
      headers: { ...headers, cookie },
      body: JSON.stringify({ registrationContext: begun.value.registrationContext }),
    });
    expect(completed.status).toBe(409);
    expect(
      value.database
        .query<{ state: string; consumed_at: number | null }, [string]>(
          "SELECT state, consumed_at FROM auth_registration_tickets WHERE auth_user_id = ?",
        )
        .get(begun.value.memberId),
    ).toEqual({ state: "PASSKEY_VERIFIED", consumed_at: null });
    expect(
      value.database
        .query<{ consumed_at: number | null }, []>(
          "SELECT consumed_at FROM invitation_exchange_sessions WHERE id = 'exchange_1'",
        )
        .get()?.consumed_at,
    ).toBeNull();
    expect(
      value.database
        .query<{ revoked_at: number | null; consumed_at: number | null }, []>(
          "SELECT revoked_at, consumed_at FROM invitations WHERE id = 'invitation_1'",
        )
        .get(),
    ).toEqual({ revoked_at: null, consumed_at: null });
    value.database.close();
  });

  test("retries a verified ticket with no passkey but preserves one whose passkey exists", async () => {
    const value = fixture();
    const exchange = await value.app.request("/invitations/exchange", {
      method: "POST",
      headers,
      body: JSON.stringify({ secret: INVITATION_SECRET, idempotencyKey: "exchange_retry" }),
    });
    const cookie = cookieFrom(exchange);
    const begin = async () =>
      value.app.request("/invitations/auth/begin", {
        method: "POST",
        headers: { ...headers, cookie },
        body: JSON.stringify({ displayName: "Invitee" }),
      });
    const first = (await (await begin()).json()) as { value: { memberId: string } };
    value.database
      .query(
        "UPDATE auth_registration_tickets SET state = 'PASSKEY_VERIFIED' WHERE auth_user_id = ?",
      )
      .run(first.value.memberId);

    const retried = await begin();
    expect(retried.status).toBe(200);
    const second = (await retried.json()) as { value: { memberId: string } };
    expect(second.value.memberId).not.toBe(first.value.memberId);
    expect(
      value.database
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM auth_users WHERE id = ?")
        .get(first.value.memberId)?.count,
    ).toBe(0);

    value.database
      .query(
        "UPDATE auth_registration_tickets SET state = 'PASSKEY_VERIFIED' WHERE auth_user_id = ?",
      )
      .run(second.value.memberId);
    value.database
      .query(
        `INSERT INTO auth_passkeys(
           id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt
         ) VALUES ('passkey_retry', 'Invitee key', 'public', ?, 'credential_retry', 0,
                   'multiDevice', 1, 1000000)`,
      )
      .run(second.value.memberId);
    expect((await begin()).status).toBe(409);
    expect(
      value.database
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM auth_passkeys WHERE userId = ?",
        )
        .get(second.value.memberId)?.count,
    ).toBe(1);
    value.database.close();
  });
});
