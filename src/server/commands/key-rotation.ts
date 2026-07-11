import type { Database } from "bun:sqlite";
import type { Result } from "../../shared/contracts/result.ts";
import type { CredentialClass } from "../modules/connectors/credentials.ts";
import { type DeploymentMasterKey, readDeploymentMasterKeyFile } from "../operations/backup.ts";
import {
  createCredentialKeyManager,
  rotateCredentialClassKey,
  rotateMasterWrappingKey,
} from "../operations/key-rotation.ts";

type Dependencies = Readonly<{
  database: Database;
  dataDirectory: string;
  backupDirectory: string;
  masterKeyFile: string | undefined;
  clock: () => number;
  id: (prefix: string) => string;
}>;

function failure(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function createKeyRotationCommand(dependencies: Dependencies) {
  const loadCurrent = () =>
    readDeploymentMasterKeyFile({
      secretFile: dependencies.masterKeyFile,
      dataDirectory: dependencies.dataDirectory,
      backupDirectory: dependencies.backupDirectory,
    });
  const manager = (key: DeploymentMasterKey) =>
    createCredentialKeyManager({
      database: dependencies.database,
      masterKey: key.bytes,
      masterKeyId: key.keyId,
      clock: dependencies.clock,
      id: dependencies.id,
    });
  return {
    async rotateClass(input: Readonly<{ credentialClass: CredentialClass; batchSize?: number }>) {
      const key = await loadCurrent();
      if (!key.ok) return key;
      return rotateCredentialClassKey({
        manager: manager(key.value),
        credentialClass: input.credentialClass,
        batchSize: input.batchSize,
      });
    },

    async rotateMaster(input: Readonly<{ nextMasterKeyFile: string }>) {
      const current = await loadCurrent();
      if (!current.ok) return current;
      const next = await readDeploymentMasterKeyFile({
        secretFile: input.nextMasterKeyFile,
        dataDirectory: dependencies.dataDirectory,
        backupDirectory: dependencies.backupDirectory,
      });
      if (!next.ok) return next;
      if (next.value.keyId === current.value.keyId) {
        return failure("MASTER_ROTATION_INPUT_INVALID", "Master rotation input is invalid.");
      }
      return rotateMasterWrappingKey({
        manager: manager(current.value),
        nextMasterKey: next.value.bytes,
        nextMasterKeyId: next.value.keyId,
      });
    },
  };
}
