import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../src/cli/commands/init.ts";
import { listCurrentProject } from "../../src/cli/commands/list.ts";
import { listKnownProjects } from "../../src/cli/commands/projects.ts";
import { projectStatus } from "../../src/cli/commands/status.ts";
import type { ProjectsApi } from "../../src/cli/ports/projects-api.ts";
import { openLocalProjectRegistry } from "../../src/runner/repository/global-registry.ts";
import type { ProjectView } from "../../src/shared/contracts/projects.ts";
import { runCli, type CliIo } from "../../src/cli/command.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "2collab-init-"));
  temporaryDirectories.push(directory);
  await Bun.$`git init -q ${directory}`;
  return directory;
}

const project = {
  id: "project_1",
  teamId: "team_1",
  name: "Project One",
  baseBranch: "trunk",
  revision: 1,
  createdAt: 100,
} as unknown as ProjectView;

function api(overrides: Partial<ProjectsApi> = {}): ProjectsApi {
  return {
    async inspect() {
      return { ok: true, value: project };
    },
    async list() {
      return { ok: true, value: [project] };
    },
    ...overrides,
  };
}

describe("collab init", () => {
  test("validates remotely, writes authoritative config atomically, then registers locally", async () => {
    const root = await repository();
    const registry = openLocalProjectRegistry(join(root, ".home", ".collab", "global.db"), {
      clock: () => 200,
    });
    const calls: unknown[] = [];
    try {
      const result = await initProject(
        { cwd: root, projectId: "project_1", serverOrigin: "https://collab.test" },
        {
          projectsApi: api({
            async inspect(input) {
              calls.push(input);
              return { ok: true, value: project };
            },
          }),
          registry,
        },
      );

      expect(result).toEqual(project);
      expect(calls).toEqual([{ serverOrigin: "https://collab.test", projectId: "project_1" }]);
      expect(await readFile(join(root, ".collab", "config.toml"), "utf8")).toBe(
        'project_id = "project_1"\nteam_id = "team_1"\nserver_url = "https://collab.test"\nbase_branch = "trunk"\n',
      );
      expect(
        registry.lookup({ projectId: "project_1", serverOrigin: "https://collab.test" })
          ?.preferredCheckout,
      ).toBe(await realpath(root));
    } finally {
      registry.close();
    }
  });

  test("repairs a crash after rename and preserves identical config bytes and mtime", async () => {
    const root = await repository();
    const registry = openLocalProjectRegistry(join(root, ".home", ".collab", "global.db"));
    let first = true;
    const crashingRegistry = {
      ...registry,
      register(
        input: Parameters<typeof registry.register>[0],
        options?: Parameters<typeof registry.register>[1],
      ) {
        if (first) {
          first = false;
          throw new Error("SIMULATED_CRASH");
        }
        return registry.register(input, options);
      },
    };
    try {
      const options = { cwd: root, projectId: "project_1", serverOrigin: "https://collab.test" };
      await expect(
        initProject(options, { projectsApi: api(), registry: crashingRegistry }),
      ).rejects.toThrow("SIMULATED_CRASH");
      const path = join(root, ".collab", "config.toml");
      const before = await stat(path);

      await initProject(options, { projectsApi: api(), registry: crashingRegistry });

      const after = await stat(path);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(
        registry.lookup({ projectId: "project_1", serverOrigin: "https://collab.test" }),
      ).toBeDefined();
    } finally {
      registry.close();
    }
  });

  test("never overwrites a different repository config", async () => {
    const root = await repository();
    await mkdir(join(root, ".collab"));
    const existing =
      'project_id="other"\nteam_id="team_1"\nserver_url="https://collab.test"\nbase_branch="main"\n';
    await writeFile(join(root, ".collab", "config.toml"), existing);
    const registry = openLocalProjectRegistry(join(root, ".home", ".collab", "global.db"));
    try {
      await expect(
        initProject(
          { cwd: root, projectId: "project_1", serverOrigin: "https://collab.test" },
          { projectsApi: api(), registry },
        ),
      ).rejects.toThrow("PROJECT_CONFIG_EXISTS");
      expect(await readFile(join(root, ".collab", "config.toml"), "utf8")).toBe(existing);
    } finally {
      registry.close();
    }
  });

  test("reclaims a repository init lock left by a crashed process", async () => {
    const root = await repository();
    await mkdir(join(root, ".collab"));
    await writeFile(join(root, ".collab", "init.lock"), "99999999\n", { mode: 0o600 });
    const registry = openLocalProjectRegistry(join(root, ".home", ".collab", "global.db"));
    try {
      await initProject(
        { cwd: root, projectId: "project_1", serverOrigin: "https://collab.test" },
        { projectsApi: api(), registry },
      );
      expect(await readFile(join(root, ".collab", "config.toml"), "utf8")).toContain(
        'project_id = "project_1"',
      );
    } finally {
      registry.close();
    }
  });

  test("does not promote a linked worktree to the preferred checkout", async () => {
    const parent = await mkdtemp(join(tmpdir(), "2collab-linked-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "main");
    const linked = join(parent, "linked");
    await mkdir(root);
    await Bun.$`git init -q ${root}`;
    await writeFile(join(root, "README.md"), "project\n");
    await Bun.$`git -C ${root} add README.md`;
    await Bun.$`git -C ${root} -c user.name=Test -c user.email=test@example.com commit -qm initial`;
    await Bun.$`git -C ${root} worktree add -qb linked-test ${linked}`;
    const registry = openLocalProjectRegistry(join(parent, ".home", ".collab", "global.db"));
    try {
      await expect(
        initProject(
          { cwd: linked, projectId: "project_1", serverOrigin: "https://collab.test" },
          { projectsApi: api(), registry },
        ),
      ).rejects.toThrow("PROJECT_CHECKOUT_TRANSIENT");
      expect(registry.list()).toEqual([]);
    } finally {
      registry.close();
    }
  });
});

describe("project CLI views", () => {
  test("uses the shared ProjectView and reports unavailable run state inside a repository", async () => {
    const root = await repository();
    await mkdir(join(root, ".collab"));
    await writeFile(
      join(root, ".collab", "config.toml"),
      'project_id="project_1"\nteam_id="team_1"\nserver_url="https://collab.test"\nbase_branch="trunk"\n',
    );
    expect(await listCurrentProject(root, api())).toEqual({
      project,
      runState: "RUN_STATE_UNAVAILABLE",
    });
    expect(await projectStatus({ cwd: root }, { projectsApi: api() })).toEqual({
      project,
      runState: "RUN_STATE_UNAVAILABLE",
    });
  });

  test("lists known projects outside repositories and reports unreachable origins honestly", async () => {
    const root = await repository();
    const registry = openLocalProjectRegistry(join(root, ".home", ".collab", "global.db"));
    try {
      registry.register({
        serverOrigin: "https://collab.test",
        projectId: "project_1",
        teamId: "team_1",
        baseBranch: "trunk",
        preferredCheckout: root,
        configSha256: "a".repeat(64),
      });
      const unavailable = api({
        async inspect() {
          return {
            ok: false,
            error: {
              code: "SERVER_UNREACHABLE",
              message: "Server is unreachable.",
              retry: "SAME_INPUT",
            },
          };
        },
      });

      expect(await listKnownProjects(registry, unavailable)).toEqual([
        {
          serverOrigin: "https://collab.test",
          projectId: "project_1",
          state: "UNREACHABLE",
          errorCode: "SERVER_UNREACHABLE",
        },
      ]);
      expect(
        await projectStatus({ cwd: join(root, ".home") }, { projectsApi: api(), registry }),
      ).toEqual({
        error: "PROJECT_NOT_IN_REPOSITORY",
        hint: "Run 'collab status --all' to show known projects.",
      });
    } finally {
      registry.close();
    }
  });
});

test("the CLI routes init and status through injected project ports", async () => {
  const root = await repository();
  const registry = openLocalProjectRegistry(join(root, ".home", ".collab", "global.db"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = { log: (line) => stdout.push(line), error: (line) => stderr.push(line) };
  try {
    expect(
      await runCli(["init", "--project", "project_1", "--server", "https://collab.test"], io, {
        environment: {},
        runtimeVersion: "1.3.10",
        cwd: root,
        projectsApi: api(),
        registry,
      }),
    ).toBe(0);
    expect(
      await runCli(["status"], io, {
        environment: {},
        runtimeVersion: "1.3.10",
        cwd: root,
        projectsApi: api(),
        registry,
      }),
    ).toBe(0);
    expect(stdout.join("\n")).toContain("RUN_STATE_UNAVAILABLE");
    expect(stderr).toEqual([]);
  } finally {
    registry.close();
  }
});
