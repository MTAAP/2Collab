import { expect, test } from "bun:test";
import { createProductionRunnerManagement } from "../../src/runner/production.ts";

test("production runner begins pairing with only the CLI bearer credential", async () => {
  let saved = false;
  let requestHeaders = new Headers();
  const management = createProductionRunnerManagement({
    baseUrl: "https://collab.test",
    home: "/tmp/collab-test-home",
    executable: "/tmp/collab",
    deviceCredentials: {
      headers: async ({ method, url }) => {
        expect(method).toBe("POST");
        expect(url).toBe("https://collab.test/api/v1/runners/pairing/begin");
        return { authorization: "Bearer member-access" };
      },
    },
    store: {
      load: async () => undefined,
      save: async () => {
        saved = true;
      },
    },
    fetch: (async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      return Response.json({
        ok: true,
        value: {
          pairingId: "runner_pairing_1",
          pairingSecret: "pairing-secret-with-at-least-thirty-two-bytes",
          expiresAt: 1_800,
        },
      });
    }) as typeof fetch,
  });

  expect(await management.pairBegin()).toEqual({
    pairingId: "runner_pairing_1",
    expiresAt: 1_800,
    approvalUrl: "https://collab.test/runners/pairing/runner_pairing_1",
  });
  expect(requestHeaders.get("authorization")).toBe("Bearer member-access");
  expect(requestHeaders.has("dpop")).toBeFalse();
  expect(requestHeaders.has("dpop-nonce")).toBeFalse();
  expect(saved).toBeTrue();
});

test("production runner publishes only opaque mapping and safe profile facts", async () => {
  const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const management = createProductionRunnerManagement({
    baseUrl: "https://collab.test",
    home: "/tmp/collab-test-home",
    executable: "/tmp/collab",
    deviceCredentials: {
      headers: async () => ({ authorization: "Bearer member-access" }),
    },
    store: {
      load: async () => ({
        keyPair: {
          publicKeyPem: "public",
          privateKeyPem: "private",
          publicKeySpki: Buffer.from("public"),
          keyThumbprint: "thumbprint",
          algorithm: "Ed25519" as const,
        },
        keyId: "runner_key_1",
        runnerId: "runner_1",
      }),
      save: async () => undefined,
    },
    fetch: (async (input, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body,
      });
      return Response.json({
        ok: true,
        value: String(input).endsWith("/profiles")
          ? {
              runnerId: "runner_1",
              profileId: "profile_1",
              version: 1,
              fingerprint: "a".repeat(64),
            }
          : {
              runnerId: "runner_1",
              projectId: "project_1",
              revision: body.expectedRevision ? body.expectedRevision + 1 : 1,
              localMappingId: body.localMappingId,
              createdAt: 1,
            },
      });
    }) as typeof fetch,
  });

  await management.registerMapping({
    projectId: "project_1",
    localMappingId: "opaque_mapping_1",
  });
  await management.replaceMapping({
    projectId: "project_1",
    localMappingId: "opaque_mapping_2",
    expectedRevision: 1,
  });
  await management.advertiseProfile({
    displayName: "Codex headless",
    adapter: "CODEX",
    hosts: ["NATIVE"],
    interactions: ["HEADLESS"],
    riskSummary: "Local command execution",
    fingerprint: "a".repeat(64),
  });
  await management.registerMapping({
    projectId: "project_1",
    localMappingId: "opaque_mapping_1",
  });

  expect(requests.map(({ url }) => url)).toEqual([
    "https://collab.test/api/v1/runners/runner_1/mappings",
    "https://collab.test/api/v1/runners/runner_1/mappings",
    "https://collab.test/api/v1/runners/runner_1/profiles",
    "https://collab.test/api/v1/runners/runner_1/mappings",
  ]);
  expect(
    requests.every(({ headers }) => headers.get("authorization") === "Bearer member-access"),
  ).toBeTrue();
  const wire = JSON.stringify(requests.map(({ body }) => body));
  expect(wire).not.toContain("/tmp/");
  expect(wire).not.toContain("executable");
  expect(wire).not.toContain("checkout");
  expect(wire).toContain("opaque_mapping_1");
  expect(wire).toContain("Local command execution");
  const first = requests[0];
  const retry = requests[3];
  if (!first || !retry) throw new Error("REQUEST_CAPTURE_MISSING");
  expect((first.body as { idempotencyKey: string }).idempotencyKey).toBe(
    (retry.body as { idempotencyKey: string }).idempotencyKey,
  );
  expect(
    requests.every(({ body }) =>
      /^runner_(?:mapping|profile)_[a-f0-9]{64}$/.test(
        (body as { idempotencyKey: string }).idempotencyKey,
      ),
    ),
  ).toBeTrue();
});
