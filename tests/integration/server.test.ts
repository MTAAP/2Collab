import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";

const servers: Bun.Server<unknown>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("collab-server", () => {
  test("reports stable health and API metadata", async () => {
    const response = await createApp().request("/healthz");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      apiVersion: "v1",
      service: "2collab",
      status: "OK",
      version: "0.1.0",
    });
  });

  test("uses a structured error envelope for unknown API routes", async () => {
    const response = await createApp().request("/api/v1/does-not-exist");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "The requested API resource does not exist.",
      },
    });
  });

  test("serves health over a real ephemeral Bun listener", async () => {
    const server = Bun.serve({
      fetch: createApp().fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);

    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toEqual(
      expect.objectContaining({ status: "OK" }),
    );
  });

  test("serves the web shell and only the allowlisted public document", async () => {
    const root = await mkdtemp(join(tmpdir(), "2collab-server-test-"));
    temporaryDirectories.push(root);
    const docsRoot = join(root, "docs");
    const webRoot = join(root, "web");
    await mkdir(docsRoot);
    await mkdir(webRoot);
    await writeFile(join(docsRoot, "START-HERE.md"), "# Start here\n");
    await writeFile(join(docsRoot, "PRIVATE.md"), "not public\n");
    await writeFile(join(webRoot, "index.html"), "<h1>2Collab</h1>\n");

    const app = createApp(undefined, { docsRoot, webRoot });

    const documentResponse = await app.request("/docs/START-HERE.md");
    expect(documentResponse.status).toBe(200);
    expect(documentResponse.headers.get("content-type")).toContain("text/markdown");
    expect(documentResponse.headers.get("content-disposition")).toBeNull();
    expect(await documentResponse.text()).toBe("# Start here\n");

    const privateDocumentResponse = await app.request("/docs/PRIVATE.md");
    expect(privateDocumentResponse.status).toBe(404);

    const spaResponse = await app.request("/runs/example");
    expect(spaResponse.status).toBe(200);
    expect(await spaResponse.text()).toContain("<h1>2Collab</h1>");
  });
});
