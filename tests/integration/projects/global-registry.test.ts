import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFilesystem from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { openLocalProjectRegistry } from "../../../src/runner/repository/global-registry.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function registryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "2collab-global-"));
  temporaryDirectories.push(directory);
  return join(directory, ".collab", "global.db");
}

const first = {
  serverOrigin: "https://one.test",
  projectId: "project_1",
  teamId: "team_1",
  baseBranch: "main",
  preferredCheckout: "/checkout/one",
  configSha256: "a".repeat(64),
};

describe("local global project registry", () => {
  test("creates an independently migrated strict WAL database with restrictive modes", async () => {
    const path = await registryPath();
    const registry = openLocalProjectRegistry(path, { clock: () => 100 });
    try {
      expect(
        registry.database
          .query<{ version: number }, []>("SELECT version FROM schema_migrations")
          .all(),
      ).toEqual([{ version: 1 }]);
      expect(
        registry.database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get(),
      ).toEqual({
        journal_mode: "wal",
      });
      expect((await lstat(join(path, ".."))).mode & 0o777).toBe(0o700);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    } finally {
      registry.close();
    }
  });

  test("rejects an unsafe concurrent initialization winner", async () => {
    const path = await registryPath();
    await mkdir(dirname(path), { recursive: true });
    const attacker = join(dirname(path), "attacker.db");
    await writeFile(attacker, "attacker");
    const filesystem = {
      ...nodeFilesystem,
      linkSync(_temporaryPath: string, destination: string) {
        nodeFilesystem.symlinkSync(attacker, destination);
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      },
    };

    expect(() => openLocalProjectRegistry(path, { filesystem } as never)).toThrow(
      "PROJECT_REGISTRY_UNSAFE",
    );
  });

  test("rejects a parent directory identity swap around registry initialization", async () => {
    const path = await registryPath();
    await mkdir(dirname(path), { recursive: true });
    let directoryStats = 0;
    const filesystem = {
      ...nodeFilesystem,
      lstatSync(candidate: Parameters<typeof nodeFilesystem.lstatSync>[0]) {
        const actual = nodeFilesystem.lstatSync(candidate);
        if (String(candidate) !== dirname(path) || ++directoryStats < 3) return actual;
        return {
          ...actual,
          ino: actual.ino + 1,
          isDirectory: () => actual.isDirectory(),
          isFile: () => actual.isFile(),
          isSymbolicLink: () => actual.isSymbolicLink(),
        };
      },
    };

    expect(() => openLocalProjectRegistry(path, { filesystem } as never)).toThrow(
      "PROJECT_REGISTRY_UNSAFE",
    );
  });

  test("rejects a registry file identity swap around database open", async () => {
    const path = await registryPath();
    const created = openLocalProjectRegistry(path);
    created.close();
    let fileStats = 0;
    const filesystem = {
      ...nodeFilesystem,
      lstatSync(candidate: Parameters<typeof nodeFilesystem.lstatSync>[0]) {
        const actual = nodeFilesystem.lstatSync(candidate);
        if (String(candidate) !== path || ++fileStats < 3) return actual;
        return {
          ...actual,
          ino: actual.ino + 1,
          isDirectory: () => actual.isDirectory(),
          isFile: () => actual.isFile(),
          isSymbolicLink: () => actual.isSymbolicLink(),
        };
      },
    };

    expect(() => openLocalProjectRegistry(path, { filesystem } as never)).toThrow(
      "PROJECT_REGISTRY_UNSAFE",
    );
  });

  test("keys by origin and project, preserves multi-origin IDs, and refuses ambiguous lookup", async () => {
    const registry = openLocalProjectRegistry(await registryPath(), { clock: () => 100 });
    try {
      registry.register(first);
      registry.register({
        ...first,
        serverOrigin: "https://two.test",
        preferredCheckout: "/checkout/two",
      });

      expect(registry.list()).toHaveLength(2);
      expect(() => registry.lookup({ projectId: "project_1" })).toThrow("PROJECT_AMBIGUOUS");
      expect(
        registry.lookup({ projectId: "project_1", serverOrigin: "https://two.test" })
          ?.preferredCheckout,
      ).toBe("/checkout/two");
    } finally {
      registry.close();
    }
  });

  test("makes preferred checkouts unique and requires explicit same-project replacement", async () => {
    const registry = openLocalProjectRegistry(await registryPath(), { clock: () => 100 });
    try {
      registry.register(first);
      expect(() => registry.register({ ...first, projectId: "project_2" })).toThrow(
        "PROJECT_MAPPING_CONFLICT",
      );
      expect(() =>
        registry.register({ ...first, preferredCheckout: "/checkout/replacement" }),
      ).toThrow("PROJECT_MAPPING_CONFLICT");
      expect(() => registry.register({ ...first, baseBranch: "other" })).toThrow(
        "PROJECT_MAPPING_CONFLICT",
      );

      registry.register(
        { ...first, preferredCheckout: "/checkout/replacement" },
        { replace: true },
      );
      expect(
        registry.lookup({ projectId: first.projectId, serverOrigin: first.serverOrigin })
          ?.preferredCheckout,
      ).toBe("/checkout/replacement");
    } finally {
      registry.close();
    }
  });

  test("fails visibly for unsafe, truncated, drifted, and newer databases", async () => {
    for (const setup of [
      async (path: string) => writeFile(path, ""),
      async (path: string) => writeFile(path, "not sqlite"),
    ]) {
      const path = await registryPath();
      await mkdir(dirname(path), { recursive: true });
      await setup(path);
      await chmod(path, 0o600);
      expect(() => openLocalProjectRegistry(path)).toThrow("PROJECT_REGISTRY_CORRUPT");
    }

    const path = await registryPath();
    const registry = openLocalProjectRegistry(path);
    registry.database.exec("INSERT INTO schema_migrations(version, applied_at) VALUES (2, 0)");
    registry.close();
    expect(() => openLocalProjectRegistry(path)).toThrow("PROJECT_REGISTRY_VERSION_UNSUPPORTED");

    const driftedPath = await registryPath();
    const drifted = openLocalProjectRegistry(driftedPath);
    drifted.database.exec("DROP TABLE project_checkouts");
    drifted.close();
    expect(() => openLocalProjectRegistry(driftedPath)).toThrow("PROJECT_REGISTRY_CORRUPT");
  });

  test("validates every persisted routing row on open, lookup, and list", async () => {
    for (const [column, value] of [
      ["server_origin", "file:///tmp/attacker"],
      ["base_branch", "../main"],
      ["preferred_checkout", "relative/checkout"],
    ] as const) {
      const path = await registryPath();
      const registry = openLocalProjectRegistry(path);
      registry.register(first);
      registry.database.query(`UPDATE project_checkouts SET ${column} = ?`).run(value);
      expect(() => registry.lookup({ projectId: "project_1" })).toThrow("PROJECT_REGISTRY_CORRUPT");
      expect(() => registry.list()).toThrow("PROJECT_REGISTRY_CORRUPT");
      registry.close();
      expect(() => openLocalProjectRegistry(path)).toThrow("PROJECT_REGISTRY_CORRUPT");
    }
  });
});
