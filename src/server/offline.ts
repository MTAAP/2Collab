#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_METADATA } from "../shared/app-metadata.ts";
import { readServerEnvironment } from "../shared/environment.ts";
import { createServerCommandDispatcher } from "./command.ts";
import { openDatabase } from "./db/connection.ts";
import { migrate, migrationCatalog } from "./db/migrate.ts";
import { offlineRestoreAuthority } from "./operations/restore.ts";

export async function dispatchOfflineServerCommand(
  args: readonly string[],
  source: Readonly<Record<string, string | undefined>> = Bun.env,
) {
  const environment = readServerEnvironment(source);
  const restoring = args[0] === "restore" && args[1] === "apply";
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    if (!restoring) {
      const directory = resolve(environment.dataDir);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      database = openDatabase(join(directory, "collab.sqlite"));
      migrate(database);
    }
    const dispatcher = createServerCommandDispatcher({
      invocationMode: "OFFLINE_OPERATION",
      operationMode: restoring ? "RESTORE" : "MAINTENANCE",
      ...(database ? { database } : {}),
      environment,
      productVersion: APP_METADATA.version,
      migrations: migrationCatalog,
      offlineRestoreAuthority,
      clock: () => Math.floor(Date.now() / 1_000),
      id: (prefix) => `${prefix}_${randomBytes(24).toString("base64url")}`,
    } as Parameters<typeof createServerCommandDispatcher>[0]);
    return await dispatcher.execute(args);
  } finally {
    database?.close();
  }
}

if (import.meta.main) {
  const result = await dispatchOfflineServerCommand(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
