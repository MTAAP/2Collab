import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRunnerDatabase } from "../../src/runner/db/connection.ts";
import { createLocalProfileRegistry, fingerprintLocalProfile } from "../../src/runner/profiles.ts";
import { createLocalProcessRegistry } from "../../src/runner/process-state.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "collab-runner-state-"));
  directories.push(directory);
  const path = join(directory, "state", "runner.db");
  return { directory, path, database: openRunnerDatabase(path) };
}

describe("runner-local state", () => {
  test("creates an owner-only strict WAL database without shared lifecycle or output fields", async () => {
    const f = await fixture();
    expect((await stat(join(f.directory, "state"))).mode & 0o777).toBe(0o700);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect(
      f.database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
    ).toBe("wal");
    const tables = f.database
      .query<{ name: string; strict: number }, []>("PRAGMA table_list")
      .all()
      .filter((row) => ["local_profile_versions", "local_processes"].includes(row.name));
    expect(tables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "local_profile_versions", strict: 1 }),
        expect.objectContaining({ name: "local_processes", strict: 1 }),
      ]),
    );
    const schema = f.database
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.sql)
      .join("\n")
      .toLowerCase();
    for (const prohibited of [
      "raw_output",
      "transcript",
      "source_body",
      "server_lifecycle",
      "credential_value",
    ]) {
      expect(schema).not.toContain(prohibited);
    }
    f.database.close();
  });

  test("publishes immutable local profile versions and verifies fingerprints on every resolve", async () => {
    const f = await fixture();
    const profiles = createLocalProfileRegistry(f.database, () => 1_000);
    const draft = {
      adapter: "CODEX",
      executable: "/opt/collab/bin/codex",
      fixedArguments: ["--model", "gpt-5"],
      promptTransport: { headless: "STDIN", interactive: "TERMINAL_INPUT" },
      supportedInteractions: ["HEADLESS", "INTERACTIVE"],
    } as const;
    const profile = { ...draft, fingerprint: fingerprintLocalProfile(draft) };
    expect(profiles.publish("profile_1", "profile_version_1", 1, profile)).toMatchObject({
      ok: true,
    });
    expect(profiles.resolve("profile_version_1", profile.fingerprint)).toEqual({
      ok: true,
      value: profile,
    });
    expect(profiles.resolve("profile_version_1", "a".repeat(64))).toMatchObject({
      ok: false,
      error: { code: "PROFILE_VERSION_MISMATCH" },
    });
    expect(() =>
      f.database
        .query("UPDATE local_profile_versions SET version = 2 WHERE id = 'profile_version_1'")
        .run(),
    ).toThrow();
    f.database.close();
  });

  test("reserves exact assignments idempotently and never duplicates a started process", async () => {
    const f = await fixture();
    const processes = createLocalProcessRegistry(
      f.database,
      () => 1_000,
      () => "reservation_1",
    );
    expect(processes.reserve("attempt_1", "a".repeat(64))).toEqual({
      ok: true,
      value: { reservationId: "reservation_1", disposition: "NEW" },
    });
    expect(processes.reserve("attempt_1", "a".repeat(64))).toEqual({
      ok: true,
      value: { reservationId: "reservation_1", disposition: "RECONCILE" },
    });
    expect(processes.reserve("attempt_1", "b".repeat(64))).toMatchObject({
      ok: false,
      error: { code: "PROCESS_ASSIGNMENT_CONFLICT" },
    });
    expect(
      processes.recordStarted(
        { reservationId: "reservation_1", disposition: "NEW" },
        {
          host: "NATIVE",
          opaqueProcessId: "process_1",
          interaction: "HEADLESS",
          assurance: "ADVISORY",
        },
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(processes.inspect("attempt_1")).toMatchObject({
      ok: true,
      value: { state: "STARTED", opaqueProcessId: "process_1" },
    });
    f.database.close();
  });

  test("fails visibly on unsafe file permissions or logical corruption", async () => {
    const f = await fixture();
    f.database.close();
    await chmod(f.path, 0o666);
    const reopened = openRunnerDatabase(f.path);
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    reopened.query("UPDATE schema_migrations SET version = 9").run();
    reopened.close();
    expect(() => openRunnerDatabase(f.path)).toThrow("RUNNER_STATE_CORRUPT");
  });
});
