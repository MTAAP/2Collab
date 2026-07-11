import { Database } from "bun:sqlite";
import { migrate } from "../../../src/server/db/migrate.ts";

export function coordinationFixture() {
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  database.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_1', 1, 'team_1', 1, 0);
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at) VALUES ('member_1', 'Member', 'MEMBER', 'ACTIVE', 1, 1, 0);
    INSERT INTO projects(id, team_id, name, base_branch, revision, created_at) VALUES ('project_1', 'team_1', 'Project', 'main', 1, 0);
    INSERT INTO connector_epochs(connector_id, epoch, review_state) VALUES ('github_1', 1, 'READY');
    INSERT INTO encrypted_credentials(id, credential_class, owner_kind, owner_id, connector_id, credential_owner_id, key_id, key_version, algorithm, nonce, ciphertext, auth_tag, revision, created_at, updated_at)
      VALUES ('private_1', 'PROVIDER', 'CONNECTOR', 'github_1', 'github_1', 'private', 'key_1', 1, 'AES_256_GCM', zeroblob(12), X'01', zeroblob(16), 1, 0, 0),
             ('secret_1', 'PROVIDER', 'CONNECTOR', 'github_1', 'github_1', 'webhook', 'key_1', 1, 'AES_256_GCM', zeroblob(12), X'02', zeroblob(16), 1, 0, 0);
    INSERT INTO github_installations(connector_id, app_id, installation_id, account_id, account_node_id, account_login, private_key_credential_id, webhook_secret_credential_id, revision, created_at, updated_at)
      VALUES ('github_1', '1', '2', '3', 'O_3', 'org', 'private_1', 'secret_1', 1, 0, 0);
    INSERT INTO coordination_records(id, project_id, title, revision, created_at, updated_at) VALUES
      ('record_a', 'project_1', 'A', 1, 0, 0), ('record_b', 'project_1', 'B', 1, 0, 0);
  `);
  return database;
}

export function seedRun(
  database: Database,
  id: string,
  recordId: string,
  state: "QUEUED" | "COMPLETED",
) {
  database
    .query(`INSERT INTO agent_runs(id, coordination_record_id, project_id, state, goal, repository_id, repository_mode, repository_assurance, base_origin, base_commit, base_branch, intended_branch, worktree_identity, effective_configuration_id, effective_configuration_version, effective_configuration_digest, dispatcher_kind, dispatcher_id, terminal_reason, revision, created_at, started_at, terminal_at)
    VALUES (?, ?, 'project_1', ?, 'Goal', 'repository_1', 'MUTATING', 'ADVISORY', 'EXACT', ?, 'main', 'branch', ?, 'configuration_1', 1, ?, 'MEMBER', 'member_1', ?, 1, 0, ?, ?)`)
    .run(
      id,
      recordId,
      state,
      "a".repeat(40),
      `worktree_${id}`,
      "b".repeat(64),
      state === "COMPLETED" ? "DELIVERED" : null,
      state === "COMPLETED" ? 1 : null,
      state === "COMPLETED" ? 2 : null,
    );
}
