import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Result } from "../shared/contracts/result.ts";
import type { ServerEnvironment } from "../shared/environment.ts";
import { createBackupCommand } from "./commands/backup.ts";
import { createKeyRotationCommand } from "./commands/key-rotation.ts";
import { createRestoreCommand } from "./commands/restore.ts";
import type { MigrationCatalog } from "./db/migrate.ts";
import type { OfflineRestoreAuthority } from "./operations/restore.ts";

type CommonDependencies = Readonly<{
  invocationMode: "OFFLINE_OPERATION";
  environment: ServerEnvironment;
  productVersion: string;
  migrations: MigrationCatalog;
  offlineRestoreAuthority: OfflineRestoreAuthority;
  clock: () => number;
  id: (prefix: string) => string;
}>;

type Dependencies =
  | (CommonDependencies & Readonly<{ operationMode: "MAINTENANCE"; database: Database }>)
  | (CommonDependencies & Readonly<{ operationMode: "RESTORE" }>);

export type ServerCommandResult = Readonly<{ operation: string; result: unknown }>;

function failure(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function createServerCommandDispatcher(dependencies: Dependencies) {
  if (dependencies.invocationMode !== "OFFLINE_OPERATION") {
    throw new Error("SERVER_COMMAND_MODE_INVALID");
  }
  const common = {
    dataDirectory: dependencies.environment.dataDir,
    backupDirectory: dependencies.environment.backupDir,
    masterKeyFile: dependencies.environment.deploymentMasterKeyFile,
    clock: dependencies.clock,
    id: dependencies.id,
  };
  const backups =
    dependencies.operationMode === "MAINTENANCE"
      ? createBackupCommand({
          ...common,
          database: dependencies.database,
          productVersion: dependencies.productVersion,
          migrations: dependencies.migrations,
        })
      : undefined;
  const keys =
    dependencies.operationMode === "MAINTENANCE"
      ? createKeyRotationCommand({ ...common, database: dependencies.database })
      : undefined;
  const restore =
    dependencies.operationMode === "RESTORE"
      ? createRestoreCommand({
          ...common,
          databasePath: join(dependencies.environment.dataDir, "collab.sqlite"),
          migrations: dependencies.migrations,
          offlineAuthority: dependencies.offlineRestoreAuthority,
        })
      : undefined;
  return {
    async execute(args: readonly string[]): Promise<Result<ServerCommandResult>> {
      if (args[0] === "backup" && args[1] === "create" && args.length === 2) {
        if (!backups)
          return failure("SERVER_COMMAND_MODE_INVALID", "Server command mode is invalid.");
        const result = await backups.create();
        return result.ok
          ? { ok: true, value: { operation: "BACKUP_CREATE", result: result.value } }
          : result;
      }
      if (args[0] === "backup" && args[1] === "retention" && args.length === 2) {
        if (!backups)
          return failure("SERVER_COMMAND_MODE_INVALID", "Server command mode is invalid.");
        const result = await backups.enforceRetention();
        return result.ok
          ? { ok: true, value: { operation: "BACKUP_RETENTION", result: result.value } }
          : result;
      }
      if (args[0] === "restore" && args[1] === "apply" && args.length === 3 && args[2]) {
        if (!restore)
          return failure("SERVER_COMMAND_MODE_INVALID", "Server command mode is invalid.");
        const result = await restore.apply({ backupPath: args[2] });
        return result.ok
          ? { ok: true, value: { operation: "RESTORE_APPLY", result: result.value } }
          : result;
      }
      if (
        args[0] === "key" &&
        args[1] === "rotate-class" &&
        ["PROVIDER", "MEMBER_OAUTH", "DEVICE_REFRESH"].includes(args[2] ?? "") &&
        args.length === 3
      ) {
        if (!keys) return failure("SERVER_COMMAND_MODE_INVALID", "Server command mode is invalid.");
        const result = await keys.rotateClass({
          credentialClass: args[2] as "PROVIDER" | "MEMBER_OAUTH" | "DEVICE_REFRESH",
        });
        return result.ok
          ? { ok: true, value: { operation: "KEY_ROTATE_CLASS", result: result.value } }
          : result;
      }
      if (args[0] === "key" && args[1] === "rotate-master" && args.length === 3 && args[2]) {
        if (!keys) return failure("SERVER_COMMAND_MODE_INVALID", "Server command mode is invalid.");
        const result = await keys.rotateMaster({ nextMasterKeyFile: args[2] });
        return result.ok
          ? { ok: true, value: { operation: "KEY_ROTATE_MASTER", result: result.value } }
          : result;
      }
      return failure("SERVER_COMMAND_INVALID", "Server command is invalid.");
    },
  };
}
