import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preflightGitHubApp,
  readApprovedGitHubLiveConfiguration,
} from "../../../src/server/adapters/github/live-preflight.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "2collab-github-preflight-"));
  directories.push(directory);
  const privateKeyFile = join(directory, "github-app.pem");
  const webhookSecretFile = join(directory, "github-webhook-secret");
  writeFileSync(
    privateKeyFile,
    "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
    {
      mode: 0o600,
    },
  );
  writeFileSync(webhookSecretFile, "a-secure-webhook-secret", { mode: 0o600 });
  return { directory, privateKeyFile, webhookSecretFile };
}

function source(files: ReturnType<typeof fixture>) {
  return {
    COLLAB_LIVE_GITHUB: "1",
    COLLAB_GITHUB_APPROVAL_ID: "approval_disposable_1",
    COLLAB_GITHUB_APP_ID: "12345",
    COLLAB_GITHUB_INSTALLATION_ID: "67890",
    COLLAB_GITHUB_PRIVATE_KEY_FILE: files.privateKeyFile,
    COLLAB_GITHUB_WEBHOOK_SECRET_FILE: files.webhookSecretFile,
    COLLAB_GITHUB_REPOSITORY_ID: "45621281",
    COLLAB_GITHUB_REPOSITORY_NODE_ID: "R_kgDOExample",
    COLLAB_GITHUB_REPOSITORY_OWNER: "svpg-gmbh",
    COLLAB_GITHUB_REPOSITORY_NAME: "2collab-disposable",
    COLLAB_GITHUB_PROJECT_NODE_ID: "PVT_kwDOExample",
    COLLAB_GITHUB_PROJECT_OWNER: "svpg-gmbh",
  };
}

describe("approved GitHub live configuration", () => {
  test("loads exact approved resource identities from owner-only regular files", async () => {
    const files = fixture();
    const result = await readApprovedGitHubLiveConfiguration(source(files));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      approvalId: "approval_disposable_1",
      appId: "12345",
      installationId: "67890",
      repository: {
        id: "45621281",
        nodeId: "R_kgDOExample",
        owner: "svpg-gmbh",
        name: "2collab-disposable",
      },
      project: { nodeId: "PVT_kwDOExample", owner: "svpg-gmbh" },
    });
    expect(result.value.privateKey).toBeInstanceOf(Uint8Array);
    expect(result.value.webhookSecret).toBeInstanceOf(Uint8Array);
  });

  test("fails closed unless the journey and exact approval are enabled", async () => {
    const files = fixture();
    expect(
      (await readApprovedGitHubLiveConfiguration({ ...source(files), COLLAB_LIVE_GITHUB: "0" })).ok,
    ).toBe(false);
    expect(
      (
        await readApprovedGitHubLiveConfiguration({
          ...source(files),
          COLLAB_GITHUB_APPROVAL_ID: undefined,
        })
      ).ok,
    ).toBe(false);
  });

  test("rejects symlinked or group-readable secret files", async () => {
    const files = fixture();
    const linked = join(files.directory, "linked.pem");
    symlinkSync(files.privateKeyFile, linked);
    expect(
      (
        await readApprovedGitHubLiveConfiguration({
          ...source(files),
          COLLAB_GITHUB_PRIVATE_KEY_FILE: linked,
        })
      ).ok,
    ).toBe(false);
    chmodSync(files.privateKeyFile, 0o644);
    expect((await readApprovedGitHubLiveConfiguration(source(files))).ok).toBe(false);
  });
});

test("preflight proves the installation token is scoped to the approved repository and Project", async () => {
  const files = fixture();
  const loaded = await readApprovedGitHubLiveConfiguration(source(files));
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const calls: { url: string; authorization?: string; body?: string }[] = [];
  const result = await preflightGitHubApp(loaded.value, {
    now: () => 1_750_000_000_000,
    createJwt: () => ({ ok: true, value: "app.jwt.value" }),
    fetcher: async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.endsWith("/access_tokens"))
        return Response.json({
          token: "installation-token",
          expires_at: "2026-07-12T12:00:00Z",
        });
      if (url.endsWith("/repositories/45621281"))
        return Response.json({
          id: 45621281,
          node_id: "R_kgDOExample",
          full_name: "svpg-gmbh/2collab-disposable",
        });
      return Response.json({
        data: {
          node: {
            id: "PVT_kwDOExample",
            title: "Disposable delivery",
            owner: { login: "svpg-gmbh" },
          },
        },
      });
    },
  });
  expect(result).toEqual({
    ok: true,
    value: {
      approvalId: "approval_disposable_1",
      installationId: "67890",
      repository: "svpg-gmbh/2collab-disposable",
      repositoryId: "45621281",
      projectNodeId: "PVT_kwDOExample",
      projectTitle: "Disposable delivery",
    },
  });
  expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ repository_ids: ["45621281"] });
  expect(calls.slice(1).every((call) => call.authorization === "Bearer installation-token")).toBe(
    true,
  );
});

test("preflight rejects a provider identity mismatch without returning token material", async () => {
  const files = fixture();
  const loaded = await readApprovedGitHubLiveConfiguration(source(files));
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const result = await preflightGitHubApp(loaded.value, {
    now: () => 1_750_000_000_000,
    createJwt: () => ({ ok: true, value: "app.jwt.value" }),
    fetcher: async (input) =>
      String(input).endsWith("/access_tokens")
        ? Response.json({ token: "secret-token", expires_at: "2026-07-12T12:00:00Z" })
        : Response.json({ id: 999, node_id: "wrong", full_name: "other/repository" }),
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("secret-token");
});
