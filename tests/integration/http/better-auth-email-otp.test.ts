import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createFoundationHttpApp } from "../../../src/server/adapters/http/app.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import type { CollabEmailOtpPort } from "../../../src/server/modules/identity/better-auth.ts";

const origin = "https://collab.example:8443";
const mutationHeaders = {
  "content-type": "application/json",
  origin,
  "sec-fetch-site": "same-origin",
};

function fixture() {
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  const requested: unknown[] = [];
  const emailOtp: CollabEmailOtpPort = {
    async request(input) {
      requested.push(input);
    },
    async verify(input) {
      if (input.otp !== "123456")
        return {
          ok: false as const,
          error: {
            code: "INTERNAL_DISTINCT_ERROR",
            message: "must not escape",
            retry: "NEVER" as const,
          },
        };
      return {
        ok: true as const,
        value: {
          memberId: "member_1",
          headers: new Headers({
            "set-auth-token": "browser-secret",
            "set-cookie":
              "__Secure-better-auth.session_token=opaque; HttpOnly; Secure; SameSite=Strict",
          }),
        },
      };
    },
    async enrollRequest(input) {
      requested.push({ enrollment: input.email });
      return { ok: true, value: { accepted: true } };
    },
    async enrollVerify(input) {
      return this.verify({ email: input.email, otp: input.otp });
    },
  };
  const app = createFoundationHttpApp({
    configuredOrigin: origin,
    rateLimits: { allow: () => true },
    betterAuth: {
      async handle() {
        return Response.json({ shouldNotReachRawEmailOtp: true });
      },
      emailOtp: {
        database,
        configuredOrigin: origin,
        clock: () => 2_000_000_000,
        emailOtp,
        rateLimits: { allow: () => true },
      },
    },
  } as never);
  return { app, database, requested };
}

describe("Better Auth email OTP HTTP facade", () => {
  test("default-denies every raw Better Auth email and password endpoint", async () => {
    const { app, database } = fixture();
    for (const path of [
      "/api/auth/email-otp/send-verification-otp",
      "/api/auth/sign-in/email-otp",
      "/api/auth/email-otp/check-verification-otp",
      "/api/auth/email-otp/verify-email",
      "/api/auth/email-otp/request-password-reset",
      "/api/auth/email-otp/reset-password",
      "/api/auth/email-otp/request-email-change",
      "/api/auth/email-otp/change-email",
      "/api/auth/forget-password/email-otp",
      "/api/auth/sign-up/email",
      "/api/auth/sign-in/email",
      "/api/auth/request-password-reset",
      "/api/auth/reset-password",
      "/api/auth/change-password",
      "/api/auth/change-email",
      "/api/auth/send-verification-email",
      "/api/auth/verify-email",
    ]) {
      const response = await app.request(`${origin}${path}`, {
        method: "POST",
      });
      expect(response.status).toBe(404);
    }
    database.close();
  });

  test("returns the same accepted projection for valid, malformed, and cross-site requests", async () => {
    const { app, database, requested } = fixture();
    const bodies = await Promise.all([
      app.request(`${origin}/api/v1/auth/email-otp/request`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          email: "person@example.com",
          displayName: "Person",
        }),
      }),
      app.request(`${origin}/api/v1/auth/email-otp/request`, {
        method: "POST",
        headers: mutationHeaders,
        body: "not-json",
      }),
      app.request(`${origin}/api/v1/auth/email-otp/request`, {
        method: "POST",
        headers: { ...mutationHeaders, origin: "https://evil.example" },
        body: JSON.stringify({ email: "person@example.com" }),
      }),
    ]).then((responses) => Promise.all(responses.map((response) => response.json())));
    expect(bodies).toEqual([
      { ok: true, value: { accepted: true } },
      { ok: true, value: { accepted: true } },
      { ok: true, value: { accepted: true } },
    ]);
    expect(requested).toEqual([{ email: "person@example.com", displayName: "Person" }]);
    database.close();
  });

  test("exposes only the sanitized HttpOnly browser session on successful verification", async () => {
    const { app, database } = fixture();
    const response = await app.request(`${origin}/api/v1/auth/email-otp/verify`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ email: "person@example.com", otp: "123456" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-auth-token")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(await response.json()).toEqual({
      ok: true,
      value: { memberId: "member_1", authenticated: true },
    });

    const invalid = await app.request(`${origin}/api/v1/auth/email-otp/verify`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ email: "person@example.com", otp: "000000" }),
    });
    expect(await invalid.json()).toEqual({
      error: {
        code: "EMAIL_OTP_INVALID",
        message: "Email verification is invalid or expired.",
      },
    });
    database.close();
  });

  test("mounts authenticated enrollment behind the Collab facade", async () => {
    const { app, database, requested } = fixture();
    const requestedEnrollment = await app.request(
      `${origin}/api/v1/auth/email-otp/enroll/request`,
      {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ email: "new-login@example.com" }),
      },
    );
    expect(await requestedEnrollment.json()).toEqual({
      ok: true,
      value: { accepted: true },
    });
    expect(requested).toContainEqual({ enrollment: "new-login@example.com" });
    const verified = await app.request(`${origin}/api/v1/auth/email-otp/enroll/verify`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ email: "new-login@example.com", otp: "123456" }),
    });
    expect(verified.headers.get("set-auth-token")).toBeNull();
    expect(verified.headers.get("set-cookie")).toContain("HttpOnly");
    expect(await verified.json()).toMatchObject({
      ok: true,
      value: { memberId: "member_1", authenticated: true },
    });
    database.close();
  });
});
