import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LATEST_SCHEMA_VERSION, migrate } from "../../../src/server/db/migrate.ts";
import { verifyGitHubSchema } from "../../../src/server/db/migrations/0007_github.verify.ts";

describe("GitHub schema migration 0007", () => {
  test("migrates empty databases to the claimed strict schema", () => {
    const database = new Database(":memory:", { strict: true });
    migrate(database);
    expect(LATEST_SCHEMA_VERSION).toBe(12);
    expect(
      database
        .query<{ version: number }, []>(
          "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ version: 12 });
    expect(() => verifyGitHubSchema(database)).not.toThrow();
    database.close();
  });

  test("rejects oversized or non-decimal provider identities", () => {
    const database = new Database(":memory:", { strict: true });
    migrate(database);
    database.exec(`
      INSERT INTO deployments(id, singleton, team_id, revision, created_at)
        VALUES ('deployment_1', 1, 'team_1', 1, 0);
      INSERT INTO projects(id, team_id, name, base_branch, revision, created_at)
        VALUES ('project_1', 'team_1', 'Project', 'main', 1, 0);
      INSERT INTO connector_epochs(connector_id, epoch, review_state)
        VALUES ('github_1', 1, 'READY');
      INSERT INTO encrypted_credentials(
        id, credential_class, owner_kind, owner_id, connector_id, credential_owner_id,
        key_id, key_version, algorithm, nonce, ciphertext, auth_tag, revision, created_at, updated_at
      ) VALUES
        ('private_key_1', 'PROVIDER', 'CONNECTOR', 'github_1', 'github_1', 'github_private_key',
         'key_1', 1, 'AES_256_GCM', zeroblob(12), X'01', zeroblob(16), 1, 0, 0),
        ('webhook_secret_1', 'PROVIDER', 'CONNECTOR', 'github_1', 'github_1', 'github_webhook_secret',
         'key_1', 1, 'AES_256_GCM', zeroblob(12), X'02', zeroblob(16), 1, 0, 0);
      INSERT INTO github_installations(
        connector_id, app_id, installation_id, account_id, account_node_id, account_login,
        private_key_credential_id, webhook_secret_credential_id, revision, created_at, updated_at
      ) VALUES ('github_1', '123', '456', '789', 'O_1', 'example', 'private_key_1', 'webhook_secret_1', 1, 0, 0);
      INSERT INTO github_project_connectors(project_id, connector_id, revision, created_at)
        VALUES ('project_1', 'github_1', 1, 0);
    `);
    expect(() =>
      database.exec(`
      INSERT INTO github_selected_repositories(
        project_id, connector_id, repository_id, repository_node_id, owner_login, name,
        permission_digest, scope_state, revision, created_at, updated_at
      ) VALUES ('project_1', 'github_1', 'not-a-number', 'R_1', 'owner', 'repo', '${"a".repeat(64)}', 'SELECTED', 1, 0, 0)
    `),
    ).toThrow();
    database.close();
  });
});
