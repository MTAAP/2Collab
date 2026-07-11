import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRunnerDatabase } from "../../src/runner/db/connection.ts";
import { createLocalDiagnostics } from "../../src/runner/local-diagnostics.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "collab-diagnostics-"));
  directories.push(directory);
  const database = openRunnerDatabase(join(directory, "runner.db"));
  let now = 1_000;
  let random = 0;
  const diagnostics = createLocalDiagnostics({
    database,
    clock: () => now,
    randomBytes: (length) => new Uint8Array(length).fill(++random),
    secrets: {
      getOrCreate() {
        return new Uint8Array(32).fill(7);
      },
    },
    reauthenticate: async (ownerMemberId, proof) =>
      ownerMemberId === "member_1" && proof === "fresh-passkey",
  });
  return { database, diagnostics, setNow: (value: number) => (now = value) };
}

describe("encrypted local diagnostics", () => {
  test("stores only encrypted bounded tails and exposes allowlisted metadata", async () => {
    const f = await fixture();
    expect(f.diagnostics.enable("correlation_1", "member_1", "HEADLESS")).toEqual({
      ok: true,
      value: { enabled: true, byteCount: 0, expiresAt: 87_400, correlationId: "correlation_1" },
    });
    expect(f.diagnostics.append("correlation_1", "diagnostic-canary-secret")).toMatchObject({
      ok: true,
      value: { byteCount: 24 },
    });
    const stored = f.database
      .query<Record<string, unknown>, []>("SELECT * FROM local_diagnostic_tails")
      .all();
    expect(JSON.stringify(stored)).not.toContain("diagnostic-canary-secret");
    const metadata = f.diagnostics.metadata("correlation_1");
    expect(metadata.ok).toBeTrue();
    expect(Object.keys(metadata.ok ? metadata.value : {}).sort()).toEqual([
      "byteCount",
      "correlationId",
      "enabled",
      "expiresAt",
    ]);
    expect(await f.diagnostics.reveal("correlation_1", "member_2", "fresh-passkey")).toMatchObject({
      ok: false,
      error: { code: "DIAGNOSTIC_OWNER_REQUIRED" },
    });
    expect(await f.diagnostics.reveal("correlation_1", "member_1", "stale")).toMatchObject({
      ok: false,
      error: { code: "DIAGNOSTIC_REAUTH_REQUIRED" },
    });
    expect(await f.diagnostics.reveal("correlation_1", "member_1", "fresh-passkey")).toEqual({
      ok: true,
      value: "diagnostic-canary-secret",
    });
    f.database.close();
  });

  test("defaults interactive collection off and enforces byte and age caps", async () => {
    const f = await fixture();
    expect(f.diagnostics.enable("interactive_1", "member_1", "INTERACTIVE")).toMatchObject({
      ok: false,
      error: { code: "DIAGNOSTIC_INTERACTIVE_DISABLED" },
    });
    expect(
      f.diagnostics.enable("interactive_1", "member_1", "INTERACTIVE", { allowInteractive: true }),
    ).toMatchObject({ ok: true });
    expect(f.diagnostics.append("interactive_1", "x".repeat(2 * 1024 * 1024 + 1))).toMatchObject({
      ok: false,
      error: { code: "DIAGNOSTIC_LIMIT_REACHED" },
    });
    f.setNow(87_400);
    expect(f.diagnostics.append("interactive_1", "expired")).toMatchObject({
      ok: false,
      error: { code: "DIAGNOSTIC_EXPIRED" },
    });
    expect(f.diagnostics.purgeExpired()).toEqual({ purged: 1 });
    expect(f.diagnostics.metadata("interactive_1")).toMatchObject({
      ok: false,
      error: { code: "DIAGNOSTIC_NOT_FOUND" },
    });
    f.database.close();
  });
});
