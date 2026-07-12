import { describe, expect, test } from "bun:test";
import {
  createDeviceCredentialProvider,
  createDeviceEnrollment,
  type DeviceCredentialStore,
} from "../../../src/cli/credentials.ts";

function memoryStore(initial?: unknown) {
  let value = initial;
  const store: DeviceCredentialStore = {
    load: async () => value,
    save: async (_origin, next) => {
      value = next;
    },
  };
  return { store, value: () => value };
}

const BASE_URL = "https://collab.example";
const DEVICE_CODE = "device-code-with-at-least-sixteen-bytes";
const ACCESS_TOKEN = "access-token-with-at-least-sixteen-bytes";

describe("RFC 8628 CLI authentication", () => {
  test("begins with the fixed client and scope while keeping the device code in Keychain", async () => {
    const memory = memoryStore();
    const requests: Array<{ url: string; body: unknown }> = [];
    const enrollment = createDeviceEnrollment(
      BASE_URL,
      (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          device_code: DEVICE_CODE,
          user_code: "ABCD-EFGH",
          verification_uri: `${BASE_URL}/device`,
          verification_uri_complete: `${BASE_URL}/device?user_code=ABCDEFGH`,
          expires_in: 600,
          interval: 5,
        });
      }) as typeof fetch,
      memory.store,
      () => 1_000,
    );

    expect(await enrollment?.begin()).toEqual({
      userCode: "ABCD-EFGH",
      approvalUrl: `${BASE_URL}/device?user_code=ABCDEFGH`,
      expiresAt: 1_600,
      interval: 5,
    });
    expect(requests).toEqual([
      {
        url: `${BASE_URL}/api/auth/device/code`,
        body: { client_id: "2collab-cli", scope: "collab:cli" },
      },
    ]);
    expect(memory.value()).toMatchObject({
      version: 1,
      kind: "PENDING",
      deviceCode: DEVICE_CODE,
    });
  });

  test("completes the standard grant and persists a versioned bearer credential", async () => {
    const memory = memoryStore({
      version: 1,
      kind: "PENDING",
      deviceCode: DEVICE_CODE,
      userCode: "ABCD-EFGH",
      approvalUrl: `${BASE_URL}/device?user_code=ABCDEFGH`,
      expiresAt: 1_600,
      interval: 5,
    });
    const requests: unknown[] = [];
    const enrollment = createDeviceEnrollment(
      BASE_URL,
      (async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({
          access_token: ACCESS_TOKEN,
          token_type: "Bearer",
          expires_in: 600,
          scope: "collab:cli",
        });
      }) as typeof fetch,
      memory.store,
      () => 1_000,
    );

    expect(await enrollment?.complete()).toEqual({ enrolled: true });
    expect(requests).toEqual([
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: DEVICE_CODE,
        client_id: "2collab-cli",
      },
    ]);
    expect(memory.value()).toEqual({
      version: 1,
      kind: "BEARER",
      accessToken: ACCESS_TOKEN,
      expiresAt: 1_600,
      scope: "collab:cli",
    });
  });

  test.each([
    ["authorization_pending", "DEVICE_AUTHORIZATION_PENDING"],
    ["slow_down", "DEVICE_AUTHORIZATION_SLOW_DOWN"],
    ["access_denied", "DEVICE_AUTHORIZATION_DENIED"],
    ["expired_token", "DEVICE_AUTHORIZATION_EXPIRED"],
    ["invalid_grant", "DEVICE_ENROLLMENT_FAILED"],
  ])("maps %s without exposing the server description", async (error, expected) => {
    const memory = memoryStore({
      version: 1,
      kind: "PENDING",
      deviceCode: DEVICE_CODE,
      userCode: "ABCD-EFGH",
      approvalUrl: `${BASE_URL}/device?user_code=ABCDEFGH`,
      expiresAt: 1_600,
      interval: 5,
    });
    const enrollment = createDeviceEnrollment(
      BASE_URL,
      (async () =>
        Response.json(
          { error, error_description: "sensitive upstream detail" },
          { status: 400 },
        )) as unknown as typeof fetch,
      memory.store,
      () => 1_000,
    );

    expect(enrollment?.complete()).rejects.toThrow(expected);
    expect(memory.value()).toMatchObject({ kind: "PENDING" });
  });

  test("fails an expired pending code without contacting the server", async () => {
    const memory = memoryStore({
      version: 1,
      kind: "PENDING",
      deviceCode: DEVICE_CODE,
      userCode: "ABCD-EFGH",
      approvalUrl: `${BASE_URL}/device?user_code=ABCDEFGH`,
      expiresAt: 999,
      interval: 5,
    });
    let requests = 0;
    const enrollment = createDeviceEnrollment(
      BASE_URL,
      (async () => {
        requests += 1;
        return Response.json({});
      }) as unknown as typeof fetch,
      memory.store,
      () => 1_000,
    );

    expect(enrollment?.complete()).rejects.toThrow("DEVICE_AUTHORIZATION_EXPIRED");
    expect(requests).toBe(0);
  });

  test("sends only a Bearer authorization header and fails closed after expiry", async () => {
    const memory = memoryStore({
      version: 1,
      kind: "BEARER",
      accessToken: ACCESS_TOKEN,
      expiresAt: 1_600,
      scope: "collab:cli",
    });
    let now = 1_000;
    const provider = createDeviceCredentialProvider(
      { COLLAB_BASE_URL: BASE_URL },
      fetch,
      memory.store,
      () => now,
    );

    expect(
      new Headers(
        await provider?.headers({
          method: "POST",
          url: `${BASE_URL}/api/v1/runners/pairing/begin`,
        }),
      ),
    ).toEqual(new Headers({ authorization: `Bearer ${ACCESS_TOKEN}` }));
    now = 1_600;
    expect(
      provider?.headers({
        method: "POST",
        url: `${BASE_URL}/api/v1/runners/pairing/begin`,
      }),
    ).rejects.toThrow("DEVICE_AUTHENTICATION_EXPIRED");
  });

  test("rejects legacy unversioned DPoP credentials", async () => {
    const memory = memoryStore({
      accessToken: ACCESS_TOKEN,
      refreshCredential: "legacy-refresh-token",
      privateJwk: {},
    });
    const provider = createDeviceCredentialProvider(
      { COLLAB_BASE_URL: BASE_URL },
      fetch,
      memory.store,
    );

    expect(
      provider?.headers({
        method: "POST",
        url: `${BASE_URL}/api/v1/runners/pairing/begin`,
      }),
    ).rejects.toThrow("DEVICE_AUTHENTICATION_REQUIRED");
  });
});
