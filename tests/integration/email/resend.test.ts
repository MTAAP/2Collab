import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createResendEmailOtpTransport,
  readResendApiKeyFile,
} from "../../../src/server/adapters/email/resend.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bounded Resend email OTP transport", () => {
  test("reads only a restrictive regular API-key file", () => {
    const root = mkdtempSync(join(tmpdir(), "2collab-resend-"));
    roots.push(root);
    const secret = join(root, "resend-api-key");
    writeFileSync(secret, "re_test_123456789012345678901234", { mode: 0o600 });
    expect(readResendApiKeyFile(secret)).toEqual({
      ok: true,
      value: "re_test_123456789012345678901234",
    });
    chmodSync(secret, 0o644);
    expect(readResendApiKeyFile(secret).ok).toBe(false);
    chmodSync(secret, 0o600);
    const linked = join(root, "linked-key");
    symlinkSync(secret, linked);
    expect(readResendApiKeyFile(linked).ok).toBe(false);
  });

  test("sends one bounded fixed-origin request without returning provider material", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = createResendEmailOtpTransport({
      apiKey: "re_test_123456789012345678901234",
      from: "auth@example.com",
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({ id: "provider_message_1" });
      },
    });
    expect(await transport.sendSignInOtp({ to: "member@example.com", otp: "123456" })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer re_test_123456789012345678901234",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      from: "auth@example.com",
      to: ["member@example.com"],
    });
  });

  test("maps redirects, provider failures, oversized responses, and invalid input to one error", async () => {
    const resultFor = async (response: Response) =>
      createResendEmailOtpTransport({
        apiKey: "re_test_123456789012345678901234",
        from: "auth@example.com",
        fetcher: async () => response,
      }).sendSignInOtp({ to: "member@example.com", otp: "123456" });
    expect((await resultFor(new Response(null, { status: 302 }))).ok).toBe(false);
    expect((await resultFor(new Response("denied", { status: 403 }))).ok).toBe(false);
    expect((await resultFor(new Response("x".repeat(4_097)))).ok).toBe(false);
    expect(
      (
        await createResendEmailOtpTransport({
          apiKey: "re_test_123456789012345678901234",
          from: "auth@example.com",
          fetcher: async () => Response.json({}),
        }).sendSignInOtp({ to: "member@example.com", otp: "not-an-otp" })
      ).ok,
    ).toBe(false);
  });
});
