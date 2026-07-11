import type { Database } from "bun:sqlite";

export const RUN_AUTHORITY_TABLES = [
  "coordination_records",
  "coordination_source_references",
  "agent_runs",
  "execution_attempts",
  "authority_snapshots",
  "dispatch_permits",
  "runner_dispatch_outbox",
] as const;

export const RUN_AUTHORITY_INDEXES = [
  "coordination_source_record",
  "agent_runs_coordination_state",
  "one_active_attempt_per_run",
  "execution_attempts_runner_state",
  "pending_runner_dispatch_outbox",
] as const;

export const RUN_AUTHORITY_TRIGGERS = [
  "coordination_record_project_immutable",
  "coordination_source_reference_immutable",
  "agent_run_provenance_immutable",
  "execution_attempt_assignment_immutable",
  "authority_snapshot_immutable",
  "dispatch_permit_claims_immutable",
  "runner_dispatch_outbox_payload_immutable",
] as const;

const RUN_AUTHORITY_SCHEMA_SHA256 =
  "8cf9fdaf6fee7bd5998b9e63dee1e9eda400e7aa86f32edfb14d751f3d0c5539";
const COALESCING_RUN_AUTHORITY_SCHEMA_SHA256 =
  "37fd777c0c35fa4a67d3c8e434e62651ae85e5093f04e36cd06f82b455cefd33";

const EXPECTED_COLUMNS: Readonly<Record<(typeof RUN_AUTHORITY_TABLES)[number], readonly string[]>> =
  {
    coordination_records: ["id", "project_id", "title", "revision", "created_at", "updated_at"],
    coordination_source_references: [
      "project_id",
      "connector_id",
      "source_item_id",
      "source_kind",
      "coordination_record_id",
      "observed_revision",
      "linked_at",
    ],
    agent_runs: [
      "id",
      "coordination_record_id",
      "project_id",
      "state",
      "goal",
      "repository_id",
      "repository_mode",
      "repository_assurance",
      "base_origin",
      "base_commit",
      "base_branch",
      "intended_branch",
      "worktree_identity",
      "effective_configuration_id",
      "effective_configuration_version",
      "effective_configuration_digest",
      "dispatcher_kind",
      "dispatcher_id",
      "dispatcher_context_id",
      "waiting_reason",
      "terminal_reason",
      "revision",
      "created_at",
      "started_at",
      "terminal_at",
    ],
    execution_attempts: [
      "id",
      "run_id",
      "project_id",
      "ordinal",
      "runner_id",
      "runner_epoch",
      "mapping_revision",
      "profile_version_id",
      "profile_version",
      "profile_fingerprint",
      "exposure_revision",
      "host",
      "interaction",
      "state",
      "revision",
      "created_at",
      "acknowledged_at",
      "started_at",
      "terminal_at",
      "exit_code",
      "signal",
      "terminal_reason",
    ],
    authority_snapshots: [
      "id",
      "attempt_id",
      "run_id",
      "project_id",
      "project_revision",
      "actor_kind",
      "actor_id",
      "actor_context_id",
      "runner_id",
      "runner_owner_member_id",
      "runner_epoch",
      "runner_policy_revision",
      "mapping_revision",
      "profile_version_id",
      "profile_version",
      "profile_fingerprint",
      "exposure_revision",
      "authorization_source",
      "security_policy_version",
      "security_digest",
      "repository_id",
      "repository_mode",
      "repository_assurance",
      "base_commit",
      "base_branch",
      "intended_branch",
      "effective_configuration_id",
      "effective_configuration_version",
      "effective_configuration_digest",
      "permit_seconds",
      "authority_session_seconds",
      "authority_renewal_seconds",
      "mutation_disconnect_grace_seconds",
      "snapshot_digest",
      "created_at",
    ],
    dispatch_permits: [
      "id",
      "attempt_id",
      "authority_snapshot_id",
      "claims_hash",
      "state",
      "revision",
      "issued_at",
      "expires_at",
      "consumed_at",
      "revoked_at",
    ],
    runner_dispatch_outbox: [
      "id",
      "delivery_kind",
      "attempt_id",
      "runner_id",
      "runner_epoch",
      "authority_snapshot_id",
      "permit_id",
      "semantic_digest",
      "status",
      "retry_count",
      "last_error_code",
      "created_at",
      "expires_at",
      "dispatched_at",
      "acknowledged_at",
    ],
  };

function names(database: Database, type: "index" | "table" | "trigger"): Set<string> {
  return new Set(
    database
      .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = ?")
      .all(type)
      .map((row) => row.name),
  );
}

export function verifyRunsAuthoritySchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  const history = versions.map((row) => row.version);
  if (
    history.length < 4 ||
    history.slice(0, 4).join(",") !== "1,2,3,4" ||
    history.some((version, index) => version !== index + 1)
  ) {
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  }
  for (const [type, expected] of [
    ["table", RUN_AUTHORITY_TABLES],
    ["index", RUN_AUTHORITY_INDEXES],
    ["trigger", RUN_AUTHORITY_TRIGGERS],
  ] as const) {
    const actual = names(database, type);
    if (expected.some((name) => !actual.has(name))) throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
  for (const table of RUN_AUTHORITY_TABLES) {
    const columns = database
      .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
      .all()
      .map((row) => row.name);
    if (
      database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict !== 1 ||
      columns.join(",") !== EXPECTED_COLUMNS[table].join(",")
    ) {
      throw new Error("SCHEMA_INTEGRITY_INVALID");
    }
  }
  const objectNames = [
    ...RUN_AUTHORITY_TABLES,
    ...RUN_AUTHORITY_INDEXES,
    ...RUN_AUTHORITY_TRIGGERS,
  ];
  const canonicalObjects = database
    .query<{ type: string; name: string; sql: string }, string[]>(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name IN (${objectNames.map(() => "?").join(",")})
       ORDER BY type, name`,
    )
    .all(...objectNames)
    .map((row) => ({ ...row, sql: row.sql.replace(/\s+/g, " ").trim() }));
  const schemaDigest = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(canonicalObjects))
    .digest("hex");
  if (
    schemaDigest !== RUN_AUTHORITY_SCHEMA_SHA256 &&
    !((history.at(-1) ?? 0) >= 8 && schemaDigest === COALESCING_RUN_AUTHORITY_SCHEMA_SHA256)
  ) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
  if (
    database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check !== "ok" ||
    database.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all().length !== 0
  ) {
    throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
}
