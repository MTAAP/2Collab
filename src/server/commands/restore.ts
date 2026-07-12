import type { Result } from "../../shared/contracts/result.ts";
import type { MigrationCatalog } from "../db/migrate.ts";
import { readDeploymentMasterKeyFile } from "../operations/backup.ts";
import {
  type OfflineRestoreAuthority,
  type RestoreResult,
  restoreBackup,
} from "../operations/restore.ts";

type Dependencies = Readonly<{
  dataDirectory: string;
  backupDirectory: string;
  databasePath: string;
  masterKeyFile: string | undefined;
  migrations: MigrationCatalog;
  offlineAuthority: OfflineRestoreAuthority;
  clock: () => number;
  id: (prefix: string) => string;
}>;

export function createRestoreCommand(dependencies: Dependencies) {
  return {
    async apply(input: Readonly<{ backupPath: string }>): Promise<Result<RestoreResult>> {
      const masterKey = await readDeploymentMasterKeyFile({
        secretFile: dependencies.masterKeyFile,
        dataDirectory: dependencies.dataDirectory,
        backupDirectory: dependencies.backupDirectory,
      });
      if (!masterKey.ok) return masterKey;
      const offline = await dependencies.offlineAuthority.acquire(dependencies.databasePath);
      if (!offline.ok) return offline;
      return restoreBackup({
        backupPath: input.backupPath,
        offlineSession: offline.value,
        masterKey: masterKey.value.bytes,
        migrations: dependencies.migrations,
        clock: dependencies.clock,
        id: dependencies.id,
      });
    },
  };
}
