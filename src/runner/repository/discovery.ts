import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseProjectConfig, type ProjectConfig } from "./config.ts";

type SafeStat = Readonly<{
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}>;

export interface DiscoveryFilesystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<SafeStat>;
  open(path: string, flags: number): Promise<FileHandle>;
}

export interface DiscoveryGit {
  root(startDirectory: string): Promise<string>;
  directories?(root: string): Promise<Readonly<{ gitDirectory: string; commonDirectory: string }>>;
}

export type DiscoveredProject = Readonly<{
  root: string;
  config: ProjectConfig;
  configSha256: string;
}>;
export type DiscoveryDependencies = Readonly<{
  filesystem?: DiscoveryFilesystem;
  git?: DiscoveryGit;
}>;

const nodeFilesystem: DiscoveryFilesystem = { realpath, lstat, open };

const processGit: DiscoveryGit = {
  async root(startDirectory) {
    const process = Bun.spawn(["git", "-C", startDirectory, "rev-parse", "--show-toplevel"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);
    if (exitCode !== 0) throw new Error("PROJECT_REPOSITORY_NOT_FOUND");
    const root = stdout.trim();
    if (!root) throw new Error("PROJECT_REPOSITORY_NOT_FOUND");
    return root;
  },
  async directories(root) {
    const process = Bun.spawn(
      ["git", "-C", root, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, output] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);
    const [gitDirectory, commonDirectory] = output.trim().split("\n");
    if (exitCode !== 0 || !gitDirectory || !commonDirectory) {
      throw new Error("PROJECT_REPOSITORY_NOT_FOUND");
    }
    return { gitDirectory, commonDirectory };
  },
};

function sameIdentity(first: SafeStat, second: SafeStat): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.mode === second.mode &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs &&
    first.ctimeMs === second.ctimeMs
  );
}

function unsafe(): never {
  throw new Error("PROJECT_CONFIG_UNSAFE");
}

export async function discoverProject(
  start: string,
  dependencies: DiscoveryDependencies = {},
): Promise<DiscoveredProject> {
  const filesystem = dependencies.filesystem ?? nodeFilesystem;
  const { root: canonicalRoot } = await resolveRepositoryRoot(start, dependencies);

  const configDirectory = join(canonicalRoot, ".collab");
  const configPath = join(configDirectory, "config.toml");
  let handle: FileHandle | undefined;
  try {
    const directoryStat = await filesystem.lstat(configDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) unsafe();
    const before = await filesystem.lstat(configPath);
    if (!before.isFile() || before.isSymbolicLink()) unsafe();
    handle = await filesystem.open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const directoryAfterOpen = await filesystem.lstat(configDirectory);
    if (!sameIdentity(directoryStat, directoryAfterOpen)) unsafe();
    const opened = (await handle.stat()) as SafeStat;
    if (!opened.isFile() || !sameIdentity(before, opened)) unsafe();
    const bytes = await handle.readFile();
    const afterOpen = (await handle.stat()) as SafeStat;
    const afterPath = await filesystem.lstat(configPath);
    const directoryAfterRead = await filesystem.lstat(configDirectory);
    if (
      !sameIdentity(opened, afterOpen) ||
      !sameIdentity(opened, afterPath) ||
      !sameIdentity(directoryStat, directoryAfterRead)
    ) {
      unsafe();
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      unsafe();
    }
    return {
      root: canonicalRoot,
      config: parseProjectConfig(source),
      configSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PROJECT_CONFIG_")) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error("PROJECT_CONFIG_NOT_FOUND");
    }
    unsafe();
  } finally {
    await handle?.close();
  }
  return unsafe();
}

export async function isPrimaryCheckout(
  root: string,
  dependencies: DiscoveryDependencies = {},
): Promise<boolean> {
  const filesystem = dependencies.filesystem ?? nodeFilesystem;
  const git = dependencies.git ?? processGit;
  const directories = git.directories;
  if (!directories) throw new Error("PROJECT_REPOSITORY_NOT_FOUND");
  const value = await directories(root);
  return (
    (await filesystem.realpath(value.gitDirectory)) ===
    (await filesystem.realpath(value.commonDirectory))
  );
}

export async function resolveRepositoryRoot(
  start: string,
  dependencies: DiscoveryDependencies = {},
): Promise<Readonly<{ root: string }>> {
  const filesystem = dependencies.filesystem ?? nodeFilesystem;
  const git = dependencies.git ?? processGit;
  let canonicalStart: string;
  try {
    canonicalStart = await filesystem.realpath(start);
    const startStat = await filesystem.lstat(canonicalStart);
    if (!startStat.isDirectory() || startStat.isSymbolicLink()) unsafe();
  } catch (error) {
    if (error instanceof Error && error.message === "PROJECT_CONFIG_UNSAFE") throw error;
    throw new Error("PROJECT_REPOSITORY_NOT_FOUND");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await filesystem.realpath(await git.root(canonicalStart));
    const rootStat = await filesystem.lstat(canonicalRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) unsafe();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PROJECT_")) throw error;
    throw new Error("PROJECT_REPOSITORY_NOT_FOUND");
  }

  return { root: canonicalRoot };
}
