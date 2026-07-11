import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProjectConfig,
  serializeProjectConfig,
} from "../../../src/runner/repository/config.ts";
import {
  discoverProject,
  type DiscoveryFilesystem,
} from "../../../src/runner/repository/discovery.ts";

const VALID_CONFIG =
  'project_id = "proj_1"\nteam_id = "team_1"\nserver_url = "https://collab.test"\nbase_branch = "main"\n';

describe("project config", () => {
  test("accepts the exact project keys and rejects traversal", () => {
    expect(parseProjectConfig(VALID_CONFIG)).toEqual({
      projectId: "proj_1",
      teamId: "team_1",
      serverUrl: "https://collab.test",
      baseBranch: "main",
    });
    expect(() =>
      parseProjectConfig(
        'project_id="../escape"\nteam_id="team_1"\nserver_url="https://collab.test"\nbase_branch="main"\n',
      ),
    ).toThrow("PROJECT_CONFIG_INVALID");
  });

  test("rejects unknown, duplicate, nested, unsafe origin, and invalid Git-ref input", () => {
    for (const source of [
      `${VALID_CONFIG}extra = "no"\n`,
      `${VALID_CONFIG}project_id = "again"\n`,
      '[nested]\nproject_id="proj_1"\nteam_id="team_1"\nserver_url="https://collab.test"\nbase_branch="main"\n',
      'project_id="proj_1"\nteam_id="team_1"\nserver_url="http://collab.test"\nbase_branch="main"\n',
      'project_id="proj_1"\nteam_id="team_1"\nserver_url="https://collab.test/path"\nbase_branch="main"\n',
      'project_id="proj_1"\nteam_id="team_1"\nserver_url="https://collab.test"\nbase_branch="../main"\n',
    ]) {
      expect(() => parseProjectConfig(source)).toThrow("PROJECT_CONFIG_INVALID");
    }
  });

  test("normalizes exact origins and emits deterministic bounded TOML", () => {
    expect(
      parseProjectConfig(
        'project_id="proj_1"\nteam_id="team_1"\nserver_url="http://localhost:3210/"\nbase_branch="refs/heads/main"\n',
      ),
    ).toEqual({
      projectId: "proj_1",
      teamId: "team_1",
      serverUrl: "http://localhost:3210",
      baseBranch: "refs/heads/main",
    });
    expect(
      serializeProjectConfig({
        projectId: "proj_1",
        teamId: "team_1",
        serverUrl: "https://collab.test",
        baseBranch: "main",
      }),
    ).toBe(VALID_CONFIG);
  });

  test("rejects oversized, control-containing, array, and dotted-key TOML", () => {
    for (const source of [
      `${VALID_CONFIG}#${"x".repeat(16 * 1024)}\n`,
      VALID_CONFIG.replace("proj_1", "proj_1\u0001"),
      'project_id=["proj_1"]\nteam_id="team_1"\nserver_url="https://collab.test"\nbase_branch="main"\n',
      'project_id.value="proj_1"\nteam_id="team_1"\nserver_url="https://collab.test"\nbase_branch="main"\n',
    ]) {
      expect(() => parseProjectConfig(source)).toThrow("PROJECT_CONFIG_INVALID");
    }
  });
});

describe("repository discovery", () => {
  test("resolves only a config at the nearest canonical Git root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "2collab-discovery-"));
    try {
      await Bun.$`git init -q ${directory}`;
      await mkdir(join(directory, ".collab"));
      await writeFile(join(directory, ".collab", "config.toml"), VALID_CONFIG);
      const nested = join(directory, "src", "nested");
      await mkdir(nested, { recursive: true });

      const project = await discoverProject(nested);

      expect(project.root).toBe(await realpath(directory));
      expect(project.config.projectId).toBe("proj_1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not inherit an outer config from a nested repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "2collab-discovery-"));
    try {
      await Bun.$`git init -q ${directory}`;
      await mkdir(join(directory, ".collab"));
      await writeFile(join(directory, ".collab", "config.toml"), VALID_CONFIG);
      const nested = join(directory, "nested");
      await mkdir(nested);
      await Bun.$`git init -q ${nested}`;

      await expect(discoverProject(nested)).rejects.toThrow("PROJECT_CONFIG_NOT_FOUND");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects symlinked config paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "2collab-discovery-"));
    try {
      await Bun.$`git init -q ${directory}`;
      const target = join(directory, "actual-config");
      await mkdir(target);
      await writeFile(join(target, "config.toml"), VALID_CONFIG);
      await symlink(target, join(directory, ".collab"));

      await expect(discoverProject(directory)).rejects.toThrow("PROJECT_CONFIG_UNSAFE");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked config file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "2collab-discovery-"));
    try {
      await Bun.$`git init -q ${directory}`;
      await mkdir(join(directory, ".collab"));
      await writeFile(join(directory, "actual-config"), VALID_CONFIG);
      await symlink(join(directory, "actual-config"), join(directory, ".collab", "config.toml"));

      await expect(discoverProject(directory)).rejects.toThrow("PROJECT_CONFIG_UNSAFE");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a config identity swap during injected filesystem revalidation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "2collab-discovery-"));
    try {
      await Bun.$`git init -q ${directory}`;
      await mkdir(join(directory, ".collab"));
      const configPath = join(directory, ".collab", "config.toml");
      await writeFile(configPath, VALID_CONFIG);
      const canonicalConfigPath = await realpath(configPath);
      let configStats = 0;
      const filesystem: DiscoveryFilesystem = {
        realpath,
        open,
        async lstat(path) {
          const actual = await lstat(path);
          if (path !== canonicalConfigPath || ++configStats < 2) return actual;
          return {
            dev: actual.dev,
            ino: actual.ino + 1,
            mode: actual.mode,
            size: actual.size,
            mtimeMs: actual.mtimeMs,
            ctimeMs: actual.ctimeMs,
            isDirectory: () => actual.isDirectory(),
            isFile: () => actual.isFile(),
            isSymbolicLink: () => actual.isSymbolicLink(),
          };
        },
      };

      await expect(discoverProject(directory, { filesystem })).rejects.toThrow(
        "PROJECT_CONFIG_UNSAFE",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
