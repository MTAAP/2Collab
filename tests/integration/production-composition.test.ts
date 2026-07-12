import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalPublicRequestUrl,
  createProductionComposition,
} from "../../src/server/dependencies.ts";
import type { ServerEnvironment } from "../../src/shared/environment.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function environment(withBootstrapSecret: boolean): ServerEnvironment {
  const directory = mkdtempSync(join(tmpdir(), "2collab-composition-"));
  directories.push(directory);
  const bootstrapSecretFile = join(directory, "bootstrap-secret");
  if (withBootstrapSecret)
    writeFileSync(bootstrapSecretFile, "bootstrap-secret-with-at-least-thirty-two-bytes\n", {
      mode: 0o600,
    });
  return {
    backupDir: join(directory, "backups"),
    bootstrapSecretFile: withBootstrapSecret ? bootstrapSecretFile : undefined,
    dataDir: join(directory, "data"),
    deploymentMasterKeyFile: undefined,
    hostname: "127.0.0.1",
    mode: "development",
    port: 0,
    publicBaseUrl: "http://localhost:3210",
    rpId: "localhost",
    rpName: "2Collab Test",
    runnerCompositionModule: undefined,
    sessionSecret: undefined,
  };
}

async function composition(withBootstrapSecret: boolean) {
  const server = await createProductionComposition(environment(withBootstrapSecret));
  return server;
}

async function request(
  server: Awaited<ReturnType<typeof createProductionComposition>>,
  input: Request,
): Promise<Response> {
  const response = await server.fetch(input, {} as never);
  if (!response) throw new Error("COMPOSITION_RESPONSE_REQUIRED");
  return response;
}

describe("packaged production composition", () => {
  test("canonicalizes proxy-internal request URLs to the configured public origin", () => {
    expect(
      canonicalPublicRequestUrl(
        new Request("http://127.0.0.1:3210/api/v1/runners/pairing/begin?attempt=1"),
        "https://collab.tailnet.example:8443",
      ),
    ).toBe("https://collab.tailnet.example:8443/api/v1/runners/pairing/begin?attempt=1");
  });

  test("stays not ready when browser bootstrap is not attainable", async () => {
    const server = await composition(false);
    expect((await request(server, new Request("http://localhost/readyz"))).status).toBe(503);
    expect(
      (await request(server, new Request("http://localhost/api/v1/bootstrap", { method: "POST" })))
        .status,
    ).toBe(404);
  });

  test("mounts browser bootstrap, device enrollment, and Automation resources", async () => {
    const server = await composition(true);
    expect((await request(server, new Request("http://localhost/readyz"))).status).toBe(200);

    const origin = {
      origin: "http://localhost:3210",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };
    const registration = await request(
      server,
      new Request("http://localhost/api/v1/bootstrap/auth/begin", {
        method: "POST",
        headers: origin,
        body: JSON.stringify({
          bootstrapSecret: "bootstrap-secret-with-at-least-thirty-two-bytes",
          displayName: "Owner",
        }),
      }),
    );
    expect(registration.status).toBe(200);

    const authentication = await request(
      server,
      new Request("http://localhost/api/auth/passkey/generate-authenticate-options", {
        headers: { origin: "http://localhost:3210", "sec-fetch-site": "same-origin" },
      }),
    );
    expect(authentication.status).toBe(200);

    const device = await request(
      server,
      new Request("http://localhost/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: "2collab-cli",
          scope: "collab:cli",
        }),
      }),
    );
    expect(device.status).toBe(200);

    const automationRoutes = [
      new Request("http://localhost/api/v1/workflow-drafts/draft_1", { method: "POST" }),
      new Request("http://localhost/api/v1/workflow-executions/workflow_1"),
      new Request("http://localhost/api/v1/workflow-presets/bind", { method: "POST" }),
    ];
    for (const input of automationRoutes) expect((await request(server, input)).status).toBe(401);
    expect(
      (
        await request(
          server,
          new Request("http://localhost/api/v1/runners/runner_1/mappings", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(401);
  });
});
