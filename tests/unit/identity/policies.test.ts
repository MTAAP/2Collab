import { afterEach, describe, expect, test } from "bun:test";
import { createIdentityFixture, type IdentityFixture } from "../../fixtures/identity.ts";

const fixtures: IdentityFixture[] = [];
const fixture = () => {
  const value = createIdentityFixture();
  fixtures.push(value);
  return value;
};

afterEach(() =>
  fixtures.splice(0).forEach((value) => {
    value.close();
  }),
);

describe("identity policies", () => {
  test("rejects a wrong bootstrap secret without persisting it", async () => {
    const value = fixture();
    const result = await value.identity.beginPasskeyRegistration({
      principal: { kind: "BOOTSTRAP", secret: "wrong-bootstrap-secret-that-is-long-enough" },
      displayName: "Mallory",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BOOTSTRAP_SECRET_INVALID");
    expect(value.databaseText()).not.toContain(value.bootstrapSecret);
  });

  test("requires a safe exact origin and configured RP ID", () => {
    const value = fixture();
    expect(() =>
      createIdentityFixture({ publicOrigin: "http://collab.example.test", rpId: "example.test" }),
    ).toThrow("IDENTITY_CONFIGURATION_INVALID");
    value.close();
    fixtures.pop();
    const https = createIdentityFixture({
      publicOrigin: "https://collab.example.test",
      rpId: "collab.example.test",
    });
    https.close();
    expect(() =>
      createIdentityFixture({
        publicOrigin: "https://collab.example.test",
        rpId: "evil.test",
      }),
    ).toThrow("IDENTITY_CONFIGURATION_INVALID");
    const parentRp = createIdentityFixture({
      publicOrigin: "https://collab.example.test",
      rpId: "example.test",
    });
    parentRp.close();
  });

  test("owner-only invitation policy does not reveal member or session inputs", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const denied = await value.identity.invite({
      actor: {
        kind: "MEMBER",
        memberId: "unknown" as never,
        sessionId: "secret-session-value" as never,
      },
      idempotencyKey: "denied-invite",
      label: "Denied",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe("OWNER_REQUIRED");
      expect(JSON.stringify(denied)).not.toContain("secret-session-value");
    }
  });

  test("maps WebAuthn failures to a stable bounded error", async () => {
    const value = fixture();
    const begun = await value.identity.beginPasskeyRegistration({
      principal: { kind: "BOOTSTRAP", secret: value.bootstrapSecret },
      displayName: "Ada",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    value.webAuthn.failRegistration = true;
    const failed = await value.identity.bootstrap({
      idempotencyKey: "bad-webauthn",
      bootstrapSecret: value.bootstrapSecret,
      displayName: "Ada",
      credentialName: "Laptop",
      challengeId: begun.value.challengeId,
      response: { challenge: begun.value.challenge, credentialId: "credential-ada" },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toEqual({
        code: "PASSKEY_VERIFICATION_FAILED",
        message: "Passkey verification failed.",
        retry: "NEVER",
      });
    }
  });

  test("binds WebAuthn verification to challenge, origin, RP ID, and user verification", async () => {
    for (const response of [
      { challenge: "wrong", credentialId: "credential-ada" },
      {
        challenge: "REPLACE",
        credentialId: "credential-ada",
        origin: "https://evil.example",
      },
      { challenge: "REPLACE", credentialId: "credential-ada", rpId: "evil.example" },
      { challenge: "REPLACE", credentialId: "credential-ada", userVerified: false },
    ]) {
      const value = fixture();
      const begun = await value.identity.beginPasskeyRegistration({
        principal: { kind: "BOOTSTRAP", secret: value.bootstrapSecret },
        displayName: "Ada",
      });
      if (!begun.ok) throw new Error(begun.error.code);
      const failed = await value.identity.bootstrap({
        idempotencyKey: `binding-${fixtures.length}`,
        bootstrapSecret: value.bootstrapSecret,
        displayName: "Ada",
        credentialName: "Laptop",
        challengeId: begun.value.challengeId,
        response: {
          ...response,
          challenge: response.challenge === "REPLACE" ? begun.value.challenge : response.challenge,
        },
      });
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error.code).toBe("PASSKEY_VERIFICATION_FAILED");
    }
  });
});
