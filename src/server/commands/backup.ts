import type { Database } from "bun:sqlite";
import type { Result } from "../../shared/contracts/result.ts";
import type { MigrationCatalog } from "../db/migrate.ts";
import {
  type BackupManifest,
  createAuthenticatedBackup,
  enforceBackupRetention,
  readDeploymentMasterKeyFile,
} from "../operations/backup.ts";

type Dependencies = Readonly<{
  database: Database;
  dataDirectory: string;
  backupDirectory: string;
  masterKeyFile: string | undefined;
  productVersion: string;
  migrations: MigrationCatalog;
  clock: () => number;
  id: (prefix: string) => string;
}>;

export function createBackupCommand(dependencies: Dependencies) {
  return {
    async create(): Promise<Result<Readonly<{ manifest: BackupManifest }>>> {
      const masterKey = await readDeploymentMasterKeyFile({
        secretFile: dependencies.masterKeyFile,
        dataDirectory: dependencies.dataDirectory,
        backupDirectory: dependencies.backupDirectory,
      });
      if (!masterKey.ok) return masterKey;
      const created = await createAuthenticatedBackup({
        database: dependencies.database,
        destinationDirectory: dependencies.backupDirectory,
        masterKey: masterKey.value.bytes,
        keyId: masterKey.value.keyId,
        productVersion: dependencies.productVersion,
        migrations: dependencies.migrations,
        clock: dependencies.clock,
        id: dependencies.id,
      });
      if (!created.ok) return created;
      return { ok: true, value: { manifest: created.value.manifest } };
    },

    async enforceRetention() {
      return enforceBackupRetention({
        database: dependencies.database,
        backupDirectory: dependencies.backupDirectory,
        now: dependencies.clock(),
        id: dependencies.id,
      });
    },
  };
}
