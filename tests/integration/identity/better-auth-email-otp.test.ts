import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { serializeSignedCookie } from "better-call";
import { migrate } from "../../../src/server/db/migrate.ts";
import { createCollabBetterAuth } from "../../../src/server/modules/identity/better-auth.ts";
import { createRegistrationPolicyService } from "../../../src/server/modules/identity/registration-policy.ts";

const origin = "https://collab.example:8443";
const secret = "email-otp-test-secret-with-at-least-thirty-two-bytes";

function fixture(
  beforeDelivery?: (message: Readonly<{ email: string; otp: string }>) => Promise<void>,
) {
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  database.exec(`
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
    VALUES
      ('owner_1', 'Owner', 'OWNER', 'ACTIVE', 1, 1, 100),
      ('member_1', 'Returning', 'MEMBER', 'ACTIVE', 2, 1, 100);
    INSERT INTO auth_users(id, name, email, emailVerified, createdAt, updatedAt)
    VALUES ('auth_1', 'Returning', 'returning@example.com', 1, 100000, 100000);
    INSERT INTO auth_member_links(auth_user_id, member_id, authority_epoch_snapshot, created_at)
    VALUES ('auth_1', 'member_1', 2, 100);
  `);
  let sequence = 0;
  const id = (prefix: string) => `${prefix}_${++sequence}`;
  const clock = () => 2_000_000_000;
  const registrationPolicy = createRegistrationPolicyService({
    database,
    clock,
    id,
  });
  const delivered: Array<{ email: string; otp: string }> = [];
  const betterAuth = createCollabBetterAuth({
    database,
    publicBaseUrl: origin,
    rpId: "collab.example",
    rpName: "2Collab Test",
    secret,
    clock,
    id,
    emailOtp: {
      registrationPolicy,
      transport: {
        async send(message) {
          await beforeDelivery?.(message);
          delivered.push(message);
        },
      },
    },
  });
  if (!betterAuth.emailOtp) throw new Error("EMAIL_OTP_TEST_CONFIGURATION_INVALID");
  return {
    betterAuth,
    emailOtp: betterAuth.emailOtp,
    database,
    delivered,
    registrationPolicy,
  };
}

describe("Better Auth verified email OTP", () => {
  test("signs in a returning explicitly linked active member regardless of registration mode", async () => {
    const { emailOtp, database, delivered } = fixture();
    await emailOtp.request({ email: " Returning@EXAMPLE.com " });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.email).toBe("returning@example.com");
    const otp = delivered[0]?.otp;
    if (!otp) throw new Error("EMAIL_OTP_NOT_DELIVERED");

    const verified = await emailOtp.verify({
      email: "returning@example.com",
      otp,
    });
    expect(verified).toMatchObject({
      ok: true,
      value: { memberId: "member_1" },
    });
    if (!verified.ok) throw new Error("EMAIL_OTP_VERIFICATION_FAILED");
    expect(verified.value.headers.get("set-auth-token")).not.toBeNull();
    expect(verified.value.headers.get("set-cookie")).toContain("HttpOnly");
    expect(
      database
        .query<{ purpose: string; memberAuthorityEpoch: number }, []>(
          "SELECT purpose, memberAuthorityEpoch FROM auth_sessions",
        )
        .get(),
    ).toEqual({ purpose: "BROWSER", memberAuthorityEpoch: 2 });
    database.close();
  });

  test("creates exactly one MEMBER only after an allowlisted email is verified", async () => {
    const { emailOtp, database, delivered, registrationPolicy } = fixture();
    expect(
      registrationPolicy.updateMode({
        actorMemberId: "owner_1",
        expectedRevision: 1,
        mode: "ALLOWLIST",
      }).ok,
    ).toBeTrue();
    expect(
      registrationPolicy.addRule({
        actorMemberId: "owner_1",
        expectedPolicyRevision: 2,
        effect: "ALLOW",
        matcher: "DOMAIN",
        value: "example.net",
        includeSubdomains: false,
      }).ok,
    ).toBeTrue();

    await emailOtp.request({
      email: "new@example.net",
      displayName: "New Member",
    });
    expect(delivered).toHaveLength(1);
    const otp = delivered[0]?.otp;
    if (!otp) throw new Error("EMAIL_OTP_NOT_DELIVERED");
    expect(
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM members").get()?.count,
    ).toBe(2);

    const verified = await emailOtp.verify({
      email: "new@example.net",
      otp,
    });
    expect(verified.ok).toBeTrue();
    expect(
      database
        .query<{ role: string; status: string }, []>(
          `SELECT members.role, members.status
           FROM members JOIN auth_member_links ON auth_member_links.member_id = members.id
           JOIN auth_users ON auth_users.id = auth_member_links.auth_user_id
           WHERE auth_users.email = 'new@example.net'`,
        )
        .get(),
    ).toEqual({ role: "MEMBER", status: "ACTIVE" });
    expect(
      database
        .query<{ state: string }, []>(
          "SELECT state FROM auth_email_registration_tickets WHERE normalized_email = 'new@example.net'",
        )
        .get(),
    ).toEqual({ state: "CONSUMED" });

    const replay = await emailOtp.verify({
      email: "new@example.net",
      otp,
    });
    expect(replay).toMatchObject({
      ok: false,
      error: { code: "EMAIL_OTP_INVALID" },
    });
    expect(
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM members").get()?.count,
    ).toBe(3);
    database.close();
  });

  test("does not send to an offboarded linked identity or reveal the decision", async () => {
    const { emailOtp, database, delivered } = fixture();
    database.query("UPDATE members SET status = 'REVOKED' WHERE id = 'member_1'").run();
    await expect(emailOtp.request({ email: "returning@example.com" })).resolves.toBeUndefined();
    expect(delivered).toHaveLength(0);
    database.close();
  });

  test("rotates codes on resend and enforces three sends per email per minute", async () => {
    const { emailOtp, database, delivered } = fixture();
    await Promise.all([
      emailOtp.request({ email: "returning@example.com" }),
      emailOtp.request({ email: "returning@example.com" }),
      emailOtp.request({ email: "returning@example.com" }),
    ]);
    await emailOtp.request({ email: "returning@example.com" });
    expect(delivered).toHaveLength(3);
    expect(
      database
        .query<{ digestLength: number; send_count: number }, []>(
          `SELECT length(email_digest) AS digestLength, send_count
           FROM auth_email_send_windows`,
        )
        .get(),
    ).toEqual({ digestLength: 32, send_count: 3 });
    const codes = delivered.map((delivery) => delivery.otp);
    const results = [];
    for (const otp of codes)
      results.push(await emailOtp.verify({ email: "returning@example.com", otp }));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => result.ok)).toMatchObject({
      ok: true,
      value: { memberId: "member_1" },
    });
    database.close();
  });

  test("enrolls a verified email onto the authenticated existing auth user without relinking", async () => {
    const { emailOtp, database, delivered } = fixture();
    const current = 2_000_000_000;
    database
      .query(
        `INSERT INTO auth_sessions(
           id, expiresAt, token, createdAt, updatedAt, userId, purpose,
           memberAuthorityEpoch, absoluteExpiresAt
         ) VALUES ('session_enroll', ?, 'enrollment-session-token-with-thirty-two-characters',
           ?, ?, 'auth_1', 'BROWSER', 2, ?)`,
      )
      .run((current + 600) * 1_000, current * 1_000, current * 1_000, (current + 600) * 1_000);
    const cookie = await serializeSignedCookie(
      "__Secure-better-auth.session_token",
      "enrollment-session-token-with-thirty-two-characters",
      secret,
    );
    const request = new Request(`${origin}/api/v1/auth/email-otp/enroll/request`, {
      method: "POST",
      headers: { cookie },
    });
    expect(
      await emailOtp.enrollRequest({
        email: "member-login@example.net",
        request,
      }),
    ).toMatchObject({ ok: true, value: { accepted: true } });
    const otp = delivered[0]?.otp;
    if (!otp) throw new Error("EMAIL_OTP_NOT_DELIVERED");
    expect(
      await emailOtp.enrollVerify({
        email: "member-login@example.net",
        otp,
        request,
      }),
    ).toMatchObject({ ok: true, value: { memberId: "member_1" } });
    expect(
      database
        .query<{ id: string; email: string; emailVerified: number }, []>(
          "SELECT id, email, emailVerified FROM auth_users WHERE id = 'auth_1'",
        )
        .get(),
    ).toEqual({
      id: "auth_1",
      email: "member-login@example.net",
      emailVerified: 1,
    });
    expect(
      database
        .query<{ auth_user_id: string; member_id: string }, []>(
          "SELECT auth_user_id, member_id FROM auth_member_links WHERE member_id = 'member_1'",
        )
        .get(),
    ).toEqual({ auth_user_id: "auth_1", member_id: "member_1" });
    database.close();
  });

  test("does not merge or change the current auth user when enrollment email collides", async () => {
    const { emailOtp, database, delivered } = fixture();
    const current = 2_000_000_000;
    database.exec(`
      INSERT INTO auth_users(id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('auth_other', 'Other', 'occupied@example.net', 1, 100000, 100000);
      INSERT INTO auth_sessions(
        id, expiresAt, token, createdAt, updatedAt, userId, purpose,
        memberAuthorityEpoch, absoluteExpiresAt
      ) VALUES (
        'session_collision', ${(current + 600) * 1_000},
        'collision-session-token-with-thirty-two-characters', ${current * 1_000},
        ${current * 1_000}, 'auth_1', 'BROWSER', 2, ${(current + 600) * 1_000}
      );
    `);
    const cookie = await serializeSignedCookie(
      "__Secure-better-auth.session_token",
      "collision-session-token-with-thirty-two-characters",
      secret,
    );
    const request = new Request(`${origin}/api/v1/auth/email-otp/enroll/request`, {
      headers: { cookie },
    });
    expect(await emailOtp.enrollRequest({ email: "occupied@example.net", request })).toMatchObject({
      ok: true,
      value: { accepted: true },
    });
    expect(delivered).toHaveLength(0);
    expect(
      database
        .query<{ email: string }, []>("SELECT email FROM auth_users WHERE id = 'auth_1'")
        .get(),
    ).toEqual({ email: "returning@example.com" });
    database.close();
  });

  test("binds invite-only onboarding to the exact active exchange and consumes it once", async () => {
    const { emailOtp, database, delivered } = fixture();
    database
      .query(
        `INSERT INTO invitations(
           id, token_hash, inviter_id, label, expires_at, revision, created_at
         ) VALUES ('invitation_1', ?, 'owner_1', 'Invitee', ?, 1, ?)`,
      )
      .run(new Uint8Array(32).fill(1), 2_000_001_000, 2_000_000_000);
    database
      .query(
        `INSERT INTO invitation_exchange_sessions(
           id, invitation_id, session_hash, revision, created_at, expires_at
         ) VALUES ('exchange_1', 'invitation_1', ?, 1, ?, ?)`,
      )
      .run(new Uint8Array(32).fill(2), 2_000_000_000, 2_000_000_900);

    await emailOtp.request({
      email: "invitee@example.org",
      displayName: "Invitee",
      invitationExchangeSessionId: "exchange_1",
    });
    expect(delivered).toHaveLength(1);
    const otp = delivered[0]?.otp;
    if (!otp) throw new Error("EMAIL_OTP_NOT_DELIVERED");
    expect(
      await emailOtp.verify({
        email: "invitee@example.org",
        otp,
        invitationExchangeSessionId: "different_exchange",
      }),
    ).toMatchObject({ ok: false, error: { code: "EMAIL_OTP_INVALID" } });
    expect(
      await emailOtp.verify({
        email: "invitee@example.org",
        otp,
        invitationExchangeSessionId: "exchange_1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      database
        .query<{ consumed_at: number | null }, []>(
          "SELECT consumed_at FROM invitation_exchange_sessions WHERE id = 'exchange_1'",
        )
        .get()?.consumed_at,
    ).toBe(2_000_000_000);
    expect(
      database
        .query<{ consumed_at: number | null }, []>(
          "SELECT consumed_at FROM invitations WHERE id = 'invitation_1'",
        )
        .get()?.consumed_at,
    ).toBe(2_000_000_000);
    database.close();
  });

  test("rechecks allowlist policy after send and before member creation", async () => {
    const { emailOtp, database, delivered, registrationPolicy } = fixture();
    expect(
      registrationPolicy.updateMode({
        actorMemberId: "owner_1",
        expectedRevision: 1,
        mode: "ALLOWLIST",
      }).ok,
    ).toBeTrue();
    expect(
      registrationPolicy.addRule({
        actorMemberId: "owner_1",
        expectedPolicyRevision: 2,
        effect: "ALLOW",
        matcher: "DOMAIN",
        value: "example.net",
        includeSubdomains: false,
      }).ok,
    ).toBeTrue();
    await emailOtp.request({ email: "race@example.net", displayName: "Race" });
    const otp = delivered[0]?.otp;
    if (!otp) throw new Error("EMAIL_OTP_NOT_DELIVERED");
    expect(
      registrationPolicy.updateMode({
        actorMemberId: "owner_1",
        expectedRevision: 3,
        mode: "CLOSED",
      }).ok,
    ).toBeTrue();
    expect(await emailOtp.verify({ email: "race@example.net", otp })).toMatchObject({
      ok: false,
      error: { code: "EMAIL_OTP_INVALID" },
    });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM auth_member_links WHERE auth_user_id IN (SELECT id FROM auth_users WHERE email = 'race@example.net')",
        )
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("rejects an issued code after offboarding and exhausts brute-force attempts", async () => {
    const { emailOtp, database, delivered } = fixture();
    await emailOtp.request({ email: "returning@example.com" });
    const offboardedOtp = delivered[0]?.otp;
    if (!offboardedOtp) throw new Error("EMAIL_OTP_NOT_DELIVERED");
    database.query("UPDATE members SET status = 'REVOKED' WHERE id = 'member_1'").run();
    expect(
      await emailOtp.verify({ email: "returning@example.com", otp: offboardedOtp }),
    ).toMatchObject({ ok: false, error: { code: "EMAIL_OTP_INVALID" } });

    database.query("UPDATE members SET status = 'ACTIVE' WHERE id = 'member_1'").run();
    await emailOtp.request({ email: "returning@example.com" });
    const validOtp = delivered.at(-1)?.otp;
    if (!validOtp) throw new Error("EMAIL_OTP_NOT_DELIVERED");
    for (const wrongOtp of ["000000", "000001", "000002"])
      expect(
        await emailOtp.verify({ email: "returning@example.com", otp: wrongOtp }),
      ).toMatchObject({
        ok: false,
        error: { code: "EMAIL_OTP_INVALID" },
      });
    expect(await emailOtp.verify({ email: "returning@example.com", otp: validOtp })).toMatchObject({
      ok: false,
      error: { code: "EMAIL_OTP_INVALID" },
    });
    database.close();
  });

  test("allows only one successful verification under concurrent replay", async () => {
    const { emailOtp, database, delivered } = fixture();
    await emailOtp.request({ email: "returning@example.com" });
    const otp = delivered[0]?.otp;
    if (!otp) throw new Error("EMAIL_OTP_NOT_DELIVERED");
    const results = await Promise.all([
      emailOtp.verify({ email: "returning@example.com", otp }),
      emailOtp.verify({ email: "returning@example.com", otp }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM auth_sessions").get()
        ?.count,
    ).toBe(1);
    database.close();
  });

  test("counts concurrent wrong guesses atomically before rejecting the valid code", async () => {
    const { emailOtp, database, delivered } = fixture();
    await emailOtp.request({ email: "returning@example.com" });
    const otp = delivered[0]?.otp;
    if (!otp) throw new Error("EMAIL_OTP_NOT_DELIVERED");
    const wrong = await Promise.all(
      ["000000", "000001", "000002"].map((guess) =>
        emailOtp.verify({ email: "returning@example.com", otp: guess }),
      ),
    );
    expect(wrong.every((result) => !result.ok)).toBeTrue();
    expect(await emailOtp.verify({ email: "returning@example.com", otp })).toMatchObject({
      ok: false,
      error: { code: "EMAIL_OTP_INVALID" },
    });
    database.close();
  });

  test("delivers concurrent resends in the same order their codes are rotated", async () => {
    let releaseFirst = () => {};
    let firstStarted = () => {};
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sends = 0;
    const { emailOtp, database, delivered } = fixture(async () => {
      sends += 1;
      if (sends === 1) {
        firstStarted();
        await release;
      }
    });
    await emailOtp.request({ email: "returning@example.com" });
    await started;
    await emailOtp.request({ email: "returning@example.com" });
    releaseFirst();
    while (delivered.length < 2) await Promise.resolve();
    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.otp).not.toBe(delivered[1]?.otp);
    expect(
      await emailOtp.verify({ email: "returning@example.com", otp: delivered[0]?.otp ?? "" }),
    ).toMatchObject({ ok: false, error: { code: "EMAIL_OTP_INVALID" } });
    expect(
      await emailOtp.verify({ email: "returning@example.com", otp: delivered[1]?.otp ?? "" }),
    ).toMatchObject({ ok: true, value: { memberId: "member_1" } });
    database.close();
  });
});
