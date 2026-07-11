import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../src/server/db/connection.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import { verifyFoundationSchema } from "../../../src/server/db/migrations/0001_foundation.verify.ts";
import { verifyProjectsSchema } from "../../../src/server/db/migrations/0002_projects.verify.ts";
import { inImmediateTransaction } from "../../../src/server/db/transaction.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function memoryDatabase(): Database {
  return new Database(":memory:", { strict: true });
}

function expectConstraint(db: Database, statement: string): void {
  expect(() => db.exec(statement)).toThrow();
}

function columnNames(db: Database, table: string): readonly string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

function fixedHash(byte: number): string {
  return `X'${byte.toString(16).padStart(2, "0").repeat(32)}'`;
}

function insertChallenge(
  db: Database,
  values: Readonly<{
    id: string;
    purpose: string;
    hashByte: number;
    memberId?: string;
    invitationExchangeSessionId?: string;
    bootstrapHashByte?: number;
  }>,
): void {
  const memberId = values.memberId === undefined ? "NULL" : `'${values.memberId}'`;
  const invitationExchangeSessionId =
    values.invitationExchangeSessionId === undefined
      ? "NULL"
      : `'${values.invitationExchangeSessionId}'`;
  const bootstrapBindingHash =
    values.bootstrapHashByte === undefined ? "NULL" : fixedHash(values.bootstrapHashByte);
  db.exec(`
    INSERT INTO webauthn_challenges(
      id, purpose, challenge_hash, member_id, invitation_exchange_session_id,
      bootstrap_binding_hash, rp_id, expected_origin, revision, created_at, expires_at
    ) VALUES (
      '${values.id}', '${values.purpose}', ${fixedHash(values.hashByte)}, ${memberId},
      ${invitationExchangeSessionId}, ${bootstrapBindingHash}, 'localhost',
      'http://localhost:3000', 1, 100, 400
    )
  `);
}

function seedOwner(db: Database): void {
  db.exec(
    "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_1', 1, 'team_1', 1, 0)",
  );
  db.exec(
    "INSERT INTO members(id, role, status, authority_epoch, revision, created_at) VALUES ('member_1', 'OWNER', 'ACTIVE', 1, 1, 0)",
  );
}

function databaseWithHistory(versions: readonly number[]): Database {
  const db = memoryDatabase();
  db.exec("CREATE TABLE schema_migrations(version INTEGER NOT NULL, applied_at INTEGER NOT NULL)");
  const insert = db.query<void, number>(
    "INSERT INTO schema_migrations(version, applied_at) VALUES (?, 0)",
  );
  for (const version of versions) insert.run(version);
  return db;
}

describe("openDatabase", () => {
  test("enables foreign keys and a busy timeout without changing in-memory journal mode", () => {
    const db = openDatabase(":memory:");
    try {
      expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()).toEqual({
        timeout: 5_000,
      });
      expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "memory",
      });
    } finally {
      db.close();
    }
  });

  test("enables WAL for a file database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "2collab-db-"));
    temporaryDirectories.push(directory);
    const db = openDatabase(join(directory, "collab.sqlite"));
    try {
      expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
    } finally {
      db.close();
    }
  });
});

describe("migrate", () => {
  test("serializes ledger creation, version decision, and migration application", () => {
    const db = memoryDatabase();
    const trace: string[] = [];
    const traced = {
      exec(statement: string) {
        trace.push(`EXEC ${statement.replaceAll(/\s+/g, " ").trim()}`);
        return db.exec(statement);
      },
      query(statement: string) {
        trace.push(`QUERY ${statement.replaceAll(/\s+/g, " ").trim()}`);
        return db.query(statement);
      },
    } as unknown as Database;

    try {
      migrate(traced);
      const begin = trace.indexOf("EXEC BEGIN IMMEDIATE");
      const ledger = trace.findIndex((entry) =>
        entry.includes("CREATE TABLE IF NOT EXISTS schema_migrations"),
      );
      const decision = trace.findIndex((entry) =>
        entry.includes("QUERY SELECT version FROM schema_migrations"),
      );
      const application = trace.findIndex((entry) => entry.includes("CREATE TABLE deployments"));
      const commit = trace.indexOf("EXEC COMMIT");

      expect(begin).toBeGreaterThanOrEqual(0);
      expect(ledger).toBeGreaterThan(begin);
      expect(decision).toBeGreaterThan(ledger);
      expect(application).toBeGreaterThan(decision);
      expect(commit).toBeGreaterThan(application);
    } finally {
      db.close();
    }
  });

  test("keeps the complete schema verified through repository observations version 16", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      migrate(db);
      verifyFoundationSchema(db);
      verifyProjectsSchema(db);

      const names = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => row.name);

      expect(names).toEqual(
        expect.arrayContaining([
          "audit_events",
          "connector_epochs",
          "deployments",
          "encrypted_credentials",
          "idempotency_results",
          "invitation_exchange_sessions",
          "invitations",
          "member_credentials",
          "members",
          "passkey_credential_transports",
          "passkey_credentials",
          "projects",
          "recovery_code_sets",
          "recovery_codes",
          "schema_migrations",
          "sessions",
          "webauthn_challenges",
        ]),
      );
      expect(
        db
          .query<{ version: number; applied_at: number }, []>(
            "SELECT version, applied_at FROM schema_migrations",
          )
          .all(),
      ).toEqual([
        { version: 1, applied_at: expect.any(Number) },
        { version: 2, applied_at: expect.any(Number) },
        { version: 3, applied_at: expect.any(Number) },
        { version: 4, applied_at: expect.any(Number) },
        { version: 5, applied_at: expect.any(Number) },
        { version: 6, applied_at: expect.any(Number) },
        { version: 7, applied_at: expect.any(Number) },
        { version: 8, applied_at: expect.any(Number) },
        { version: 9, applied_at: expect.any(Number) },
        { version: 10, applied_at: expect.any(Number) },
        { version: 11, applied_at: expect.any(Number) },
        { version: 12, applied_at: expect.any(Number) },
        { version: 13, applied_at: expect.any(Number) },
        { version: 14, applied_at: expect.any(Number) },
        { version: 15, applied_at: expect.any(Number) },
        { version: 16, applied_at: expect.any(Number) },
      ]);
      expect(
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM schema_migrations").get(),
      ).toEqual({ count: 16 });
    } finally {
      db.close();
    }
  });

  test("allows one deployment and rejects a second singleton deployment", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      db.exec(
        "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_1', 1, 'team_1', 1, 0)",
      );
      expectConstraint(
        db,
        "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_2', 1, 'team_2', 1, 0)",
      );
      expect(
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM deployments").get(),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("enforces positive mutable revisions and epochs", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      expectConstraint(
        db,
        "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_1', 1, 'team_1', 0, 0)",
      );
      expectConstraint(
        db,
        "INSERT INTO members(id, role, status, authority_epoch, revision, created_at) VALUES ('member_1', 'OWNER', 'ACTIVE', 0, 1, 0)",
      );
      expectConstraint(
        db,
        "INSERT INTO members(id, role, status, authority_epoch, revision, created_at) VALUES ('member_1', 'OWNER', 'ACTIVE', 1, 0, 0)",
      );
      expectConstraint(
        db,
        "INSERT INTO connector_epochs(connector_id, epoch, review_state) VALUES ('connector_1', 0, 'READY')",
      );
      expectConstraint(
        db,
        "INSERT INTO projects(id, team_id, name, revision, created_at) VALUES ('project_1', 'team_1', 'Project', -1, 0)",
      );
    } finally {
      db.close();
    }
  });

  test("enforces nonnegative timestamps", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      expectConstraint(
        db,
        "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_1', 1, 'team_1', 1, -1)",
      );
      expectConstraint(
        db,
        "INSERT INTO audit_events(id, kind, actor_kind, actor_id, safe_details, created_at) VALUES ('audit_1', 'BOOTSTRAP', 'MEMBER', 'member_1', '{}', -1)",
      );
      expectConstraint(
        db,
        "INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES ('member_1', 'key_1', 'hash_1', '{}', -1)",
      );
    } finally {
      db.close();
    }
  });

  test("enforces member credential foreign keys", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      expectConstraint(
        db,
        "INSERT INTO member_credentials(id, member_id, kind, issuer, subject, revision, created_at) VALUES ('credential_1', 'missing_member', 'OIDC', 'https://issuer.test', 'subject_1', 1, 0)",
      );
    } finally {
      db.close();
    }
  });

  test("stores explicit lossless passkey metadata without a generic lifecycle payload", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      seedOwner(db);
      db.exec(`
        INSERT INTO passkey_credentials(
          id, member_id, credential_id, public_key, opaque_user_id, signature_counter,
          backup_eligible, backup_state, device_type, name, revision, created_at
        ) VALUES (
          'passkey_1', 'member_1', 'ABEi_w', X'00FFA501', X'00112233445566778899AABBCCDDEEFF', 7,
          1, 1, 'MULTI_DEVICE', 'Laptop passkey', 1, 100
        )
      `);
      db.exec(
        "INSERT INTO passkey_credential_transports(passkey_credential_id, transport) VALUES ('passkey_1', 'INTERNAL'), ('passkey_1', 'HYBRID')",
      );

      const stored = db
        .query<{ credential_id: string; public_key: Uint8Array; opaque_user_id: Uint8Array }, []>(
          "SELECT credential_id, public_key, opaque_user_id FROM passkey_credentials WHERE id = 'passkey_1'",
        )
        .get();
      expect(stored?.credential_id).toBe("ABEi_w");
      expect(stored?.public_key).toEqual(Uint8Array.from([0x00, 0xff, 0xa5, 0x01]));
      expect(stored?.opaque_user_id).toHaveLength(16);
      expect(columnNames(db, "passkey_credentials")).not.toContain("public_data");
      expect(columnNames(db, "passkey_credentials")).not.toContain("metadata_json");
      expect(
        db
          .query<{ transport: string }, []>(
            "SELECT transport FROM passkey_credential_transports ORDER BY transport",
          )
          .all(),
      ).toEqual([{ transport: "HYBRID" }, { transport: "INTERNAL" }]);
    } finally {
      db.close();
    }
  });

  test("rejects invalid passkey counters, backup state, lifecycle time, and transports", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      seedOwner(db);
      const base = `
        INSERT INTO passkey_credentials(
          id, member_id, credential_id, public_key, opaque_user_id, signature_counter,
          backup_eligible, backup_state, device_type, name, revision, created_at, last_used_at
        ) VALUES`;
      expectConstraint(
        db,
        `${base} ('bad_counter', 'member_1', 'AQ', X'01', X'00112233445566778899AABBCCDDEEFF', -1, 0, 0, 'SINGLE_DEVICE', 'Bad', 1, 0, NULL)`,
      );
      expectConstraint(
        db,
        `${base} ('bad_backup', 'member_1', 'Ag', X'01', X'00112233445566778899AABBCCDDEEFF', 0, 0, 1, 'MULTI_DEVICE', 'Bad', 1, 0, NULL)`,
      );
      expectConstraint(
        db,
        `${base} ('bad_time', 'member_1', 'Aw', X'01', X'00112233445566778899AABBCCDDEEFF', 0, 0, 0, 'SINGLE_DEVICE', 'Bad', 1, 10, 9)`,
      );
      db.exec(
        `${base} ('passkey_1', 'member_1', 'BA', X'01', X'00112233445566778899AABBCCDDEEFF', 0, 0, 0, 'SINGLE_DEVICE', 'Valid', 1, 0, NULL)`,
      );
      expectConstraint(
        db,
        "INSERT INTO passkey_credential_transports(passkey_credential_id, transport) VALUES ('passkey_1', 'NETWORK')",
      );
    } finally {
      db.close();
    }
  });

  test("stores bounded base64url passkey credential IDs while keeping opaque bytes lossless", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      seedOwner(db);
      const insert = (id: string, credentialId: string): void => {
        db.exec(`
          INSERT INTO passkey_credentials(
            id, member_id, credential_id, public_key, opaque_user_id, signature_counter,
            backup_eligible, backup_state, device_type, name, revision, created_at
          ) VALUES (
            '${id}', 'member_1', '${credentialId}', X'00FFA501',
            X'00112233445566778899AABBCCDDEEFF', 0, 0, 0, 'SINGLE_DEVICE', 'Passkey', 1, 0
          )
        `);
      };

      insert("passkey_valid", "ABEi_w");
      expectConstraint(
        db,
        "INSERT INTO passkey_credentials(id, member_id, credential_id, public_key, opaque_user_id, signature_counter, backup_eligible, backup_state, device_type, name, revision, created_at) VALUES ('passkey_padding', 'member_1', 'abc=', X'01', X'00112233445566778899AABBCCDDEEFF', 0, 0, 0, 'SINGLE_DEVICE', 'Bad', 1, 0)",
      );
      expectConstraint(
        db,
        "INSERT INTO passkey_credentials(id, member_id, credential_id, public_key, opaque_user_id, signature_counter, backup_eligible, backup_state, device_type, name, revision, created_at) VALUES ('passkey_alphabet', 'member_1', 'abc+', X'01', X'00112233445566778899AABBCCDDEEFF', 0, 0, 0, 'SINGLE_DEVICE', 'Bad', 1, 0)",
      );
      expectConstraint(
        db,
        "INSERT INTO passkey_credentials(id, member_id, credential_id, public_key, opaque_user_id, signature_counter, backup_eligible, backup_state, device_type, name, revision, created_at) VALUES ('passkey_empty', 'member_1', '', X'01', X'00112233445566778899AABBCCDDEEFF', 0, 0, 0, 'SINGLE_DEVICE', 'Bad', 1, 0)",
      );

      const stored = db
        .query<{ credential_id: string; public_key: Uint8Array; opaque_user_id: Uint8Array }, []>(
          "SELECT credential_id, public_key, opaque_user_id FROM passkey_credentials WHERE id = 'passkey_valid'",
        )
        .get();
      expect(stored?.credential_id).toBe("ABEi_w");
      expect(stored?.public_key).toEqual(Uint8Array.from([0x00, 0xff, 0xa5, 0x01]));
      expect(stored?.opaque_user_id).toHaveLength(16);
    } finally {
      db.close();
    }
  });

  test("stores purpose-bound one-time WebAuthn challenges as hashes only", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      db.exec(`
        INSERT INTO webauthn_challenges(
          id, purpose, challenge_hash, bootstrap_binding_hash, rp_id, expected_origin,
          revision, created_at, expires_at
        ) VALUES (
          'challenge_1', 'PASSKEY_REGISTRATION', X'000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F',
          X'000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F',
          'localhost', 'http://localhost:3000', 1, 100, 400
        )
      `);
      const columns = columnNames(db, "webauthn_challenges");
      expect(columns).toContain("challenge_hash");
      expect(columns).not.toContain("challenge");
      expect(columns).not.toContain("payload_json");
      expectConstraint(
        db,
        "INSERT INTO webauthn_challenges(id, purpose, challenge_hash, rp_id, expected_origin, revision, created_at, expires_at) VALUES ('challenge_duplicate', 'PASSKEY_AUTHENTICATION', X'000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F', 'localhost', 'http://localhost:3000', 1, 100, 400)",
      );
      expectConstraint(
        db,
        "INSERT INTO webauthn_challenges(id, purpose, challenge_hash, rp_id, expected_origin, revision, created_at, expires_at) VALUES ('challenge_2', 'PASSKEY_REGISTRATION', X'00', 'localhost', 'http://localhost:3000', 1, 0, 10)",
      );
      expectConstraint(
        db,
        "UPDATE webauthn_challenges SET consumed_at = 200, revoked_at = 200 WHERE id = 'challenge_1'",
      );
    } finally {
      db.close();
    }
  });

  test("fully discriminates valid WebAuthn challenge bindings by purpose", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      seedOwner(db);
      db.exec(
        "INSERT INTO invitations(id, token_hash, inviter_id, label, expires_at, revision, created_at) VALUES ('invite_1', X'000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F', 'member_1', 'Teammate', 200000, 1, 100)",
      );
      db.exec(
        "INSERT INTO invitation_exchange_sessions(id, invitation_id, session_hash, revision, created_at, expires_at) VALUES ('exchange_1', 'invite_1', X'101112131415161718191A1B1C1D1E1F202122232425262728292A2B2C2D2E2F', 1, 1000, 1900)",
      );

      insertChallenge(db, {
        id: "registration_member",
        purpose: "PASSKEY_REGISTRATION",
        hashByte: 1,
        memberId: "member_1",
      });
      insertChallenge(db, {
        id: "registration_invitation",
        purpose: "PASSKEY_REGISTRATION",
        hashByte: 2,
        invitationExchangeSessionId: "exchange_1",
      });
      insertChallenge(db, {
        id: "registration_bootstrap",
        purpose: "PASSKEY_REGISTRATION",
        hashByte: 3,
        bootstrapHashByte: 103,
      });
      insertChallenge(db, {
        id: "authentication_discoverable",
        purpose: "PASSKEY_AUTHENTICATION",
        hashByte: 4,
      });
      insertChallenge(db, {
        id: "authentication_member",
        purpose: "PASSKEY_AUTHENTICATION",
        hashByte: 5,
        memberId: "member_1",
      });
      insertChallenge(db, {
        id: "privileged_member",
        purpose: "PRIVILEGED_REAUTHENTICATION",
        hashByte: 6,
        memberId: "member_1",
      });

      expect(() =>
        insertChallenge(db, {
          id: "registration_unbound",
          purpose: "PASSKEY_REGISTRATION",
          hashByte: 11,
        }),
      ).toThrow();
      expect(() =>
        insertChallenge(db, {
          id: "registration_multiple",
          purpose: "PASSKEY_REGISTRATION",
          hashByte: 12,
          memberId: "member_1",
          invitationExchangeSessionId: "exchange_1",
        }),
      ).toThrow();
      expect(() =>
        insertChallenge(db, {
          id: "authentication_invitation",
          purpose: "PASSKEY_AUTHENTICATION",
          hashByte: 13,
          invitationExchangeSessionId: "exchange_1",
        }),
      ).toThrow();
      expect(() =>
        insertChallenge(db, {
          id: "authentication_bootstrap",
          purpose: "PASSKEY_AUTHENTICATION",
          hashByte: 14,
          bootstrapHashByte: 114,
        }),
      ).toThrow();
      expect(() =>
        insertChallenge(db, {
          id: "privileged_unbound",
          purpose: "PRIVILEGED_REAUTHENTICATION",
          hashByte: 15,
        }),
      ).toThrow();
      expect(() =>
        insertChallenge(db, {
          id: "privileged_invitation",
          purpose: "PRIVILEGED_REAUTHENTICATION",
          hashByte: 16,
          memberId: "member_1",
          invitationExchangeSessionId: "exchange_1",
        }),
      ).toThrow();
      expect(() =>
        insertChallenge(db, {
          id: "privileged_bootstrap",
          purpose: "PRIVILEGED_REAUTHENTICATION",
          hashByte: 17,
          memberId: "member_1",
          bootstrapHashByte: 117,
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("supports a 15-minute invitation exchange session without an existing invitee member", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      seedOwner(db);
      db.exec(
        "INSERT INTO invitations(id, token_hash, inviter_id, label, expires_at, revision, created_at) VALUES ('invite_1', X'000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F', 'member_1', 'Teammate', 200000, 1, 100)",
      );
      db.exec(
        "INSERT INTO invitation_exchange_sessions(id, invitation_id, session_hash, revision, created_at, expires_at) VALUES ('exchange_1', 'invite_1', X'101112131415161718191A1B1C1D1E1F202122232425262728292A2B2C2D2E2F', 1, 1000, 1900)",
      );
      expect(columnNames(db, "invitations")).toContain("created_at");
      expect(columnNames(db, "invitation_exchange_sessions")).not.toContain("member_id");
      expect(columnNames(db, "invitation_exchange_sessions")).not.toContain("session_secret");
      expectConstraint(
        db,
        "INSERT INTO invitation_exchange_sessions(id, invitation_id, session_hash, revision, created_at, expires_at) VALUES ('exchange_2', 'invite_1', X'202122232425262728292A2B2C2D2E2F303132333435363738393A3B3C3D3E3F', 1, 1000, 1901)",
      );
      expectConstraint(
        db,
        "INSERT INTO invitation_exchange_sessions(id, invitation_id, session_hash, revision, created_at, expires_at) VALUES ('exchange_duplicate', 'invite_1', X'303132333435363738393A3B3C3D3E3F404142434445464748494A4B4C4D4E4F', 1, 2000, 2900)",
      );
      expectConstraint(
        db,
        "UPDATE invitation_exchange_sessions SET consumed_at = 1100, revoked_at = 1100 WHERE id = 'exchange_1'",
      );
    } finally {
      db.close();
    }
  });

  test("stores salted recovery-code state and permits rotation only after revocation", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      seedOwner(db);
      db.exec(
        "INSERT INTO recovery_code_sets(id, member_id, generation, revision, created_at) VALUES ('set_1', 'member_1', 1, 1, 100)",
      );
      db.exec(
        "INSERT INTO recovery_codes(id, recovery_code_set_id, code_index, salt, code_hash, revision, created_at) VALUES ('code_1', 'set_1', 0, X'000102030405060708090A0B0C0D0E0F', X'000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F', 1, 100)",
      );
      expectConstraint(
        db,
        "INSERT INTO recovery_code_sets(id, member_id, generation, revision, created_at) VALUES ('set_2', 'member_1', 2, 1, 200)",
      );
      db.exec("UPDATE recovery_code_sets SET revoked_at = 200, revision = 2 WHERE id = 'set_1'");
      db.exec(
        "INSERT INTO recovery_code_sets(id, member_id, generation, revision, created_at) VALUES ('set_2', 'member_1', 2, 1, 200)",
      );
      const columns = columnNames(db, "recovery_codes");
      expect(columns).toContain("salt");
      expect(columns).toContain("code_hash");
      expect(columns).not.toContain("code");
      expect(columns).not.toContain("payload_json");
      expectConstraint(
        db,
        "UPDATE recovery_codes SET consumed_at = 150, revoked_at = 150 WHERE id = 'code_1'",
      );
    } finally {
      db.close();
    }
  });

  test("uses explicit provider identity columns instead of generic credential JSON", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      seedOwner(db);
      db.exec(
        "INSERT INTO member_credentials(id, member_id, kind, issuer, subject, revision, created_at) VALUES ('provider_1', 'member_1', 'OIDC', 'https://issuer.test', 'subject_1', 1, 100)",
      );
      const columns = columnNames(db, "member_credentials");
      expect(columns).toEqual(expect.arrayContaining(["kind", "issuer", "subject"]));
      expect(columns).not.toContain("secret_hash");
      expect(columns).not.toContain("public_data");
    } finally {
      db.close();
    }
  });

  test("refuses a database with an unknown newer schema version", () => {
    const db = databaseWithHistory([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    try {
      expect(() => migrate(db)).toThrow("SCHEMA_VERSION_NEWER_THAN_SUPPORTED");
    } finally {
      db.close();
    }
  });

  for (const [versions, label] of [
    [[0], "non-positive"],
    [[1, 1], "duplicate"],
    [[1, 3], "non-contiguous"],
  ] as const) {
    test(`rejects a ${label} migration history`, () => {
      const db = databaseWithHistory(versions);
      try {
        expect(() => migrate(db)).toThrow("SCHEMA_MIGRATION_HISTORY_INVALID");
      } finally {
        db.close();
      }
    });
  }

  test("rejects a claimed schema with missing foundation objects", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      db.exec("DROP TABLE audit_events");
      expect(() => migrate(db)).toThrow("SCHEMA_INTEGRITY_INVALID");
    } finally {
      db.close();
    }
  });

  test("rejects a claimed schema missing a security index", () => {
    const db = memoryDatabase();
    try {
      migrate(db);
      db.exec("DROP INDEX one_active_recovery_code_set_per_member");
      expect(() => migrate(db)).toThrow("SCHEMA_INTEGRITY_INVALID");
    } finally {
      db.close();
    }
  });
});

test("inImmediateTransaction rolls back all writes when the operation throws", () => {
  const db = memoryDatabase();
  try {
    db.exec("CREATE TABLE values_for_test(value TEXT NOT NULL)");
    expect(() =>
      inImmediateTransaction(db, () => {
        db.exec("INSERT INTO values_for_test(value) VALUES ('uncommitted')");
        throw new Error("OPERATION_FAILED");
      }),
    ).toThrow("OPERATION_FAILED");
    expect(
      db.query<{ count: number }, []>("SELECT count(*) AS count FROM values_for_test").get(),
    ).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});
