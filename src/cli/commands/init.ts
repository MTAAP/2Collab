import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { ProjectIdentityRequestSchema, type ProjectsApi } from "../ports/projects-api.ts";
import { parseProjectConfig, serializeProjectConfig } from "../../runner/repository/config.ts";
import {
  isPrimaryCheckout,
  resolveRepositoryRoot,
  type DiscoveryGit,
} from "../../runner/repository/discovery.ts";
import type { LocalProjectRegistry } from "../../runner/repository/global-registry.ts";
import type { ProjectId } from "../../shared/contracts/ids.ts";
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
  filesystem?: InitFilesystem;
  git?: DiscoveryGit;
}>;

export interface InitFilesystem {
  link(existingPath: string, newPath: string): Promise<void>;
  lstat(path: string): Promise<Stats>;
  mkdir(path: string, options: { mode: number }): Promise<string | undefined>;
  open(path: string, flags: string | number, mode?: number): Promise<FileHandle>;
  realpath(path: string): Promise<string>;
  rm(path: string, options?: { force?: boolean }): Promise<void>;
}

const nodeFilesystem: InitFilesystem = { link, lstat, mkdir, open, realpath, rm };

function sameNode(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

async function assertDirectory(
  filesystem: InitFilesystem,
  path: string,
  identity?: Stats,
): Promise<Stats> {
  const current = await filesystem.lstat(path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    (identity !== undefined && !sameNode(identity, current))
  ) {
    throw new Error("PROJECT_CONFIG_UNSAFE");
  }
  return current;
}

async function removeIfParentCurrent(
  filesystem: InitFilesystem,
  path: string,
  directoryIdentity: Stats,
): Promise<void> {
  try {
    await assertDirectory(filesystem, dirname(path), directoryIdentity);
    await filesystem.rm(path, { force: true });
  } catch {
    // Never follow a replaced parent merely to clean up a temporary path.
  }
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function writeConfigIfAbsent(
  path: string,
  content: string,
  filesystem: InitFilesystem,
  directoryIdentity: Stats,
): Promise<string> {
  const directoryPath = dirname(path);
  try {
    await assertDirectory(filesystem, directoryPath, directoryIdentity);
    const metadata = await filesystem.lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("PROJECT_CONFIG_UNSAFE");
    const handle = await filesystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let existing: string;
    try {
      await assertDirectory(filesystem, directoryPath, directoryIdentity);
      const opened = await handle.stat();
      if (!opened.isFile() || !sameNode(metadata, opened)) {
        throw new Error("PROJECT_CONFIG_UNSAFE");
      }
      existing = await handle.readFile("utf8");
      const afterOpen = await handle.stat();
      const afterPath = await filesystem.lstat(path);
      await assertDirectory(filesystem, directoryPath, directoryIdentity);
      if (!sameNode(opened, afterOpen) || !sameNode(opened, afterPath)) {
        throw new Error("PROJECT_CONFIG_UNSAFE");
      }
    } finally {
      await handle.close();
    }
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
  await assertDirectory(filesystem, directoryPath, directoryIdentity);
  const handle = await filesystem.open(temporaryPath, "wx", 0o600);
  let temporaryIdentity!: Stats;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    temporaryIdentity = await handle.stat();
  } finally {
    await handle.close();
  }
  try {
    await assertDirectory(filesystem, directoryPath, directoryIdentity);
    await filesystem.link(temporaryPath, path);
    const installed = await filesystem.lstat(path);
    if (
      !installed.isFile() ||
      installed.isSymbolicLink() ||
      !sameNode(temporaryIdentity, installed)
    ) {
      throw new Error("PROJECT_CONFIG_UNSAFE");
    }
    await filesystem.rm(temporaryPath);
    await assertDirectory(filesystem, directoryPath, directoryIdentity);
    const directory = await filesystem.open(directoryPath, "r");
    try {
      const openedDirectory = await directory.stat();
      if (!openedDirectory.isDirectory() || !sameNode(directoryIdentity, openedDirectory)) {
        throw new Error("PROJECT_CONFIG_UNSAFE");
      }
      await directory.sync();
      await assertDirectory(filesystem, directoryPath, directoryIdentity);
    } finally {
      await directory.close();
    }
  } catch (error) {
    await removeIfParentCurrent(filesystem, temporaryPath, directoryIdentity);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      await assertDirectory(filesystem, directoryPath, directoryIdentity);
      return writeConfigIfAbsent(path, content, filesystem, directoryIdentity);
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

async function acquireInitLock(
  path: string,
  filesystem: InitFilesystem,
  directoryIdentity: Stats,
): Promise<FileHandle> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let created: FileHandle | undefined;
    try {
      await assertDirectory(filesystem, dirname(path), directoryIdentity);
      created = await filesystem.open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      await created.writeFile(`${process.pid}\n`, "utf8");
      await created.sync();
      const opened = await created.stat();
      const named = await filesystem.lstat(path);
      await assertDirectory(filesystem, dirname(path), directoryIdentity);
      if (!sameNode(opened, named)) throw new Error("PROJECT_CONFIG_UNSAFE");
      return created;
    } catch (error) {
      if (created) {
        await created.close();
        await removeIfParentCurrent(filesystem, path, directoryIdentity);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertDirectory(filesystem, dirname(path), directoryIdentity);
      const before = await filesystem.lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 32) {
        throw new Error("PROJECT_CONFIG_UNSAFE");
      }
      const existing = await filesystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let owner: number;
      try {
        const opened = await existing.stat();
        if (!sameNode(before, opened)) throw new Error("PROJECT_CONFIG_UNSAFE");
        owner = Number.parseInt(await existing.readFile("utf8"), 10);
        const after = await filesystem.lstat(path);
        await assertDirectory(filesystem, dirname(path), directoryIdentity);
        if (!sameNode(opened, after)) throw new Error("PROJECT_CONFIG_UNSAFE");
      } finally {
        await existing.close();
      }
      if (!Number.isFinite(owner)) {
        throw new Error("PROJECT_CONFIG_UNSAFE");
      }
      if (Number.isSafeInteger(owner) && owner > 0 && !processIsAlive(owner)) {
        await filesystem.rm(path);
        await assertDirectory(filesystem, dirname(path), directoryIdentity);
        continue;
      }
      await Bun.sleep(25);
    }
  }
  throw new Error("PROJECT_INIT_BUSY");
}

async function releaseInitLock(
  path: string,
  handle: FileHandle,
  filesystem: InitFilesystem,
  directoryIdentity: Stats,
): Promise<void> {
  const opened = await handle.stat();
  await handle.close();
  try {
    await assertDirectory(filesystem, dirname(path), directoryIdentity);
    const current = await filesystem.lstat(path);
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error("PROJECT_CONFIG_UNSAFE");
    }
    await filesystem.rm(path);
    await assertDirectory(filesystem, dirname(path), directoryIdentity);
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
  const identity = ProjectIdentityRequestSchema.safeParse({
    serverOrigin: options.serverOrigin,
    projectId: options.projectId,
  });
  if (!identity.success || identity.data.serverOrigin !== options.serverOrigin) {
    throw new Error("PROJECT_IDENTITY_INVALID");
  }
  const filesystem = dependencies.filesystem ?? nodeFilesystem;
  const discoveryDependencies = dependencies.git
    ? { filesystem, git: dependencies.git }
    : { filesystem };
  const { root } = await resolveRepositoryRoot(options.cwd, discoveryDependencies);
  if (!(await isPrimaryCheckout(root, discoveryDependencies))) {
    throw new Error("PROJECT_CHECKOUT_TRANSIENT");
  }
  const collabDirectory = join(root, ".collab");
  try {
    const metadata = await filesystem.lstat(collabDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("PROJECT_CONFIG_UNSAFE");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await filesystem.mkdir(collabDirectory, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
  }
  const directoryIdentity = await assertDirectory(filesystem, collabDirectory);

  const remote = await dependencies.projectsApi.inspect({
    serverOrigin: origin.data,
    projectId: identity.data.projectId as ProjectId,
  });
  if (!remote.ok) throw new Error(remote.error.code);
  const parsedProject = ProjectViewSchema.safeParse(remote.value);
  if (!parsedProject.success || parsedProject.data.id !== options.projectId) {
    throw new Error("PROJECT_IDENTITY_MISMATCH");
  }

  const lockPath = join(collabDirectory, "init.lock");
  await assertDirectory(filesystem, collabDirectory, directoryIdentity);
  const lock = await acquireInitLock(lockPath, filesystem, directoryIdentity);
  try {
    const content = serializeProjectConfig({
      projectId: parsedProject.data.id,
      teamId: parsedProject.data.teamId,
      serverUrl: origin.data,
      baseBranch: parsedProject.data.baseBranch,
    });
    const persisted = await writeConfigIfAbsent(
      join(collabDirectory, "config.toml"),
      content,
      filesystem,
      directoryIdentity,
    );
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
    await releaseInitLock(lockPath, lock, filesystem, directoryIdentity);
  }
  return parsedProject.data as ProjectView;
}
