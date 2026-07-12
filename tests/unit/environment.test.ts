import { describe, expect, test } from "bun:test";
import { readServerEnvironment } from "../../src/shared/environment.ts";

describe("readServerEnvironment", () => {
  test("uses loopback-safe development defaults", () => {
    expect(readServerEnvironment({})).toEqual({
      backupDir: "./backups",
      bootstrapSecretFile: undefined,
      dataDir: "./data",
      deploymentMasterKeyFile: undefined,
      hostname: "127.0.0.1",
      mode: "development",
      port: 3210,
      publicBaseUrl: "http://localhost:3210",
      rpId: "localhost",
      rpName: "2Collab",
      runnerCompositionModule: undefined,
      sessionSecret: undefined,
    });
  });

  test("accepts an explicit valid port", () => {
    expect(readServerEnvironment({ PORT: "4321" }).port).toBe(4321);
  });

  test("accepts a paired HTTPS Outline origin and token file", () => {
    const environment = readServerEnvironment({
      OUTLINE_BASE_URL: "https://wiki.example.test/",
      OUTLINE_TOKEN_FILE: "/run/secrets/outline_api_token",
    });
    expect(environment.outlineBaseUrl).toBe("https://wiki.example.test/");
    expect(environment.outlineTokenFile).toBe("/run/secrets/outline_api_token");
  });

  test("accepts only paired email OTP delivery configuration", () => {
    const configured = readServerEnvironment({
      RESEND_API_KEY_FILE: "/run/secrets/resend_api_key",
      AUTH_EMAIL_FROM: "auth@example.com",
    });
    expect(configured.resendApiKeyFile).toBe("/run/secrets/resend_api_key");
    expect(configured.authEmailFrom).toBe("auth@example.com");
    expect(() => readServerEnvironment({ RESEND_API_KEY_FILE: "/tmp/key" })).toThrow(
      "RESEND_API_KEY_FILE and AUTH_EMAIL_FROM",
    );
    expect(() => readServerEnvironment({ AUTH_EMAIL_FROM: "not-an-email" })).toThrow(
      "RESEND_API_KEY_FILE and AUTH_EMAIL_FROM",
    );
  });

  test("rejects incomplete or non-HTTPS Outline configuration", () => {
    expect(() => readServerEnvironment({ OUTLINE_BASE_URL: "https://wiki.example.test/" })).toThrow(
      "configured together",
    );
    expect(() =>
      readServerEnvironment({
        OUTLINE_BASE_URL: "http://wiki.example.test/",
        OUTLINE_TOKEN_FILE: "/run/secrets/outline_api_token",
      }),
    ).toThrow("HTTPS origin");
  });

  test("rejects a port outside the TCP range", () => {
    expect(() => readServerEnvironment({ PORT: "70000" })).toThrow("PORT");
  });

  test("rejects a non-numeric port", () => {
    expect(() => readServerEnvironment({ PORT: "not-a-port" })).toThrow("PORT");
  });

  test("requires a non-placeholder session secret in production", () => {
    expect(() =>
      readServerEnvironment({
        NODE_ENV: "production",
        SESSION_SECRET: "replace-with-a-random-production-secret",
      }),
    ).toThrow("SESSION_SECRET");
  });

  test("rejects a low-entropy production session secret", () => {
    expect(() =>
      readServerEnvironment({
        NODE_ENV: "production",
        SESSION_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toThrow("SESSION_SECRET");
  });

  test("accepts a strong production session secret", () => {
    const environment = readServerEnvironment({
      HOST: "0.0.0.0",
      NODE_ENV: "production",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      PUBLIC_BASE_URL: "https://collab.example",
      WEBAUTHN_RP_ID: "collab.example",
      DEPLOYMENT_MASTER_KEY_FILE: "/run/secrets/deployment_master_key",
    });

    expect(environment.hostname).toBe("0.0.0.0");
    expect(environment.mode).toBe("production");
    expect(environment.sessionSecret).toHaveLength(32);
  });

  test("requires an HTTPS canonical URL, matching RP ID, and master key in production", () => {
    const base = {
      NODE_ENV: "production",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      DEPLOYMENT_MASTER_KEY_FILE: "/run/secrets/key",
    };
    expect(() =>
      readServerEnvironment({
        ...base,
        PUBLIC_BASE_URL: "http://collab.example",
        WEBAUTHN_RP_ID: "collab.example",
      }),
    ).toThrow("PUBLIC_BASE_URL");
    expect(() =>
      readServerEnvironment({
        ...base,
        PUBLIC_BASE_URL: "https://collab.example",
        WEBAUTHN_RP_ID: "evil.example",
      }),
    ).toThrow("WEBAUTHN_RP_ID");
    expect(() =>
      readServerEnvironment({
        ...base,
        DEPLOYMENT_MASTER_KEY_FILE: undefined,
        PUBLIC_BASE_URL: "https://collab.example",
        WEBAUTHN_RP_ID: "collab.example",
      }),
    ).toThrow("DEPLOYMENT_MASTER_KEY_FILE");
  });
});
