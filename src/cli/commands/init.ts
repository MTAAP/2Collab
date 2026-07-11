import { link, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { ProjectsApi } from "../ports/projects-api.ts";
import { parseProjectConfig, serializeProjectConfig } from "../../runner/repository/config.ts";
import { resolveRepositoryRoot } from "../../runner/repository/discovery.ts";
import type { LocalProjectRegistry } from "../../runner/repository/global-registry.ts";
import {
  CanonicalServerOriginSchema,
  ProjectViewSchema,
  type ProjectView,
} from "../../shared/contracts/projects.ts";

export type InitProjectOptions = Readonly<{
  cwd: string;
  projectId: string;
  serverOrigin: string;
  replaceLocalMapping?: boolean;
}>;

export type InitProjectDependencies = Readonly<{
  projectsApi: ProjectsApi;
  registry: LocalProjectRegistry;
}>;

async function assertPrimaryCheckout(root: string): Promise<void> {
  const process = Bun.spawn(
    ["git", "-C", root, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, output] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
  ]);
  if (exitCode !== 0) throw new Error("PROJECT_REPOSITORY_NOT_FOUND");
  const [gitDirectory, commonDirectory] = output.trim().split("\n");
  if (!gitDirectory || !commonDirectory) throw new Error("PROJECT_REPOSITORY_NOT_FOUND");
  if ((await realpath(gitDirectory)) !== (await realpath(commonDirectory))) {
    throw new Error("PROJECT_CHECKOUT_TRANSIENT");
  }
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function writeConfigIfAbsent(path: string, content: string): Promise<string> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("PROJECT_CONFIG_UNSAFE");
    const existing = await readFile(path, "utf8");
    const expected = parseProjectConfig(content);
    const actual = parseProjectConfig(existing);
    if (
      actual.projectId !== expected.projectId ||
      actual.teamId !== expected.teamId ||
      actual.serverUrl !== expected.serverUrl ||
      actual.baseBranch !== expected.baseBranch
    ) {
      throw new Error("PROJECT_CONFIG_EXISTS");
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporaryPath = join(dirname(path), `.config.toml.${Bun.randomUUIDv7()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, path);
    await rm(temporaryPath);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return writeConfigIfAbsent(path, content);
    }
    throw error;
  }
  return content;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireInitLock(path: string): Promise<FileHandle> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let created: FileHandle | undefined;
    try {
      created = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      await created.writeFile(`${process.pid}\n`, "utf8");
      await created.sync();
      return created;
    } catch (error) {
      if (created) {
        await created.close();
        await rm(path, { force: true });
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 32) {
        throw new Error("PROJECT_CONFIG_UNSAFE");
      }
      const owner = Number.parseInt(await readFile(path, "utf8"), 10);
      const after = await lstat(path);
      if (before.dev !== after.dev || before.ino !== after.ino) {
        throw new Error("PROJECT_CONFIG_UNSAFE");
      }
      if (Number.isSafeInteger(owner) && owner > 0 && !processIsAlive(owner)) {
        await rm(path);
        continue;
      }
      await Bun.sleep(25);
    }
  }
  throw new Error("PROJECT_INIT_BUSY");
}

async function releaseInitLock(path: string, handle: FileHandle): Promise<void> {
  const opened = await handle.stat();
  await handle.close();
  try {
    const current = await lstat(path);
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error("PROJECT_CONFIG_UNSAFE");
    }
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function initProject(
  options: InitProjectOptions,
  dependencies: InitProjectDependencies,
): Promise<ProjectView> {
  const origin = CanonicalServerOriginSchema.safeParse(options.serverOrigin);
  if (!origin.success || origin.data !== options.serverOrigin) {
    throw new Error("PROJECT_SERVER_ORIGIN_INVALID");
  }
  const { root } = await resolveRepositoryRoot(options.cwd);
  await assertPrimaryCheckout(root);
  const collabDirectory = join(root, ".collab");
  try {
    const metadata = await lstat(collabDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("PROJECT_CONFIG_UNSAFE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(collabDirectory, { mode: 0o700 });
  }

  const remote = await dependencies.projectsApi.inspect({
    serverOrigin: origin.data,
    projectId: options.projectId,
  });
  if (!remote.ok) throw new Error(remote.error.code);
  const parsedProject = ProjectViewSchema.safeParse(remote.value);
  if (!parsedProject.success || parsedProject.data.id !== options.projectId) {
    throw new Error("PROJECT_IDENTITY_MISMATCH");
  }

  const lockPath = join(collabDirectory, "init.lock");
  const lock = await acquireInitLock(lockPath);
  try {
    const content = serializeProjectConfig({
      projectId: parsedProject.data.id,
      teamId: parsedProject.data.teamId,
      serverUrl: origin.data,
      baseBranch: parsedProject.data.baseBranch,
    });
    const persisted = await writeConfigIfAbsent(join(collabDirectory, "config.toml"), content);
    dependencies.registry.register(
      {
        serverOrigin: origin.data,
        projectId: parsedProject.data.id,
        teamId: parsedProject.data.teamId,
        baseBranch: parsedProject.data.baseBranch,
        preferredCheckout: root,
        configSha256: sha256(persisted),
      },
      { replace: options.replaceLocalMapping === true },
    );
  } finally {
    await releaseInitLock(lockPath, lock);
  }
  return parsedProject.data as ProjectView;
}
