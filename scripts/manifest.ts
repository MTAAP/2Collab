import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const manifestPath = join(root, "MANIFEST.sha256");
const excludedDirectories = new Set([
  ".git",
  ".worktrees",
  ".superpowers",
  "coverage",
  "credentials",
  "data",
  "dist",
  "node_modules",
  "playwright-report",
  "runner-state",
  "test-results",
  "transcripts",
]);
const excludedFiles = new Set([".DS_Store", ".git", "MANIFEST.sha256"]);
const portablePath = /^[A-Za-z0-9._/-]+$/;

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function compareBytes(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

async function collectFiles(directory = root): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const repositoryPath = toPosixPath(relative(root, absolutePath));

    if (entry.isSymbolicLink()) {
      throw new Error(
        `Symbolic links are not permitted in the release inventory: ${repositoryPath}`,
      );
    }

    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) {
        files.push(...(await collectFiles(absolutePath)));
      }
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(`Non-regular filesystem entry is not permitted: ${repositoryPath}`);
    }

    if (excludedFiles.has(entry.name) || entry.name.startsWith("._")) {
      continue;
    }

    if (!portablePath.test(repositoryPath) || repositoryPath.includes("..")) {
      throw new Error(`Non-portable release path: ${repositoryPath}`);
    }

    files.push(repositoryPath);
  }

  return files.sort(compareBytes);
}

async function hashFile(repositoryPath: string): Promise<string> {
  const bytes = await readFile(join(root, repositoryPath));
  return createHash("sha256").update(bytes).digest("hex");
}

async function currentEntries(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const normalizedPaths = new Map<string, string>();
  for (const path of await collectFiles()) {
    const normalized = path.normalize("NFC").toLowerCase();
    const collision = normalizedPaths.get(normalized);
    if (collision && collision !== path) {
      throw new Error(
        `Release paths collide by case or Unicode normalization: ${collision}, ${path}`,
      );
    }
    normalizedPaths.set(normalized, path);
    result.set(path, await hashFile(path));
  }
  return result;
}

async function generate(): Promise<void> {
  const entries = await currentEntries();
  const body = `${[...entries].map(([path, digest]) => `${digest}  ${path}`).join("\n")}\n`;
  const temporaryPath = `${manifestPath}.tmp`;

  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o644 });
  await rename(temporaryPath, manifestPath);
  console.log(`Wrote ${entries.size} checksums to MANIFEST.sha256`);
}

async function verify(): Promise<void> {
  const manifestStat = await lstat(manifestPath).catch(() => undefined);
  if (!manifestStat?.isFile()) {
    throw new Error("MANIFEST.sha256 is missing or is not a regular file");
  }

  const expected = new Map<string, string>();
  const lines = (await readFile(manifestPath, "utf8")).split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length === 0 && index === lines.length - 1) {
      continue;
    }

    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._/-]+)$/.exec(line);
    if (!match) {
      throw new Error(`Malformed checksum line ${index + 1}`);
    }

    const [, digest, path] = match;
    if (path.includes("..") || path.startsWith("/") || expected.has(path)) {
      throw new Error(`Unsafe or duplicate checksum path on line ${index + 1}: ${path}`);
    }
    expected.set(path, digest);
  }

  const actual = await currentEntries();
  const expectedPaths = [...expected.keys()].sort(compareBytes);
  const actualPaths = [...actual.keys()];
  if (expectedPaths.join("\n") !== actualPaths.join("\n")) {
    const missing = expectedPaths.filter((path) => !actual.has(path));
    const extra = actualPaths.filter((path) => !expected.has(path));
    throw new Error(
      `Release inventory differs from MANIFEST.sha256; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`,
    );
  }

  for (const [path, digest] of actual) {
    if (expected.get(path) !== digest) {
      throw new Error(`Checksum mismatch: ${path}`);
    }
  }

  console.log(`Verified ${actual.size} checksums from MANIFEST.sha256`);
}

const command = process.argv[2];

try {
  if (command === "generate") {
    await generate();
  } else if (command === "verify") {
    await verify();
  } else {
    throw new Error("Usage: bun run scripts/manifest.ts <generate|verify>");
  }
} catch (error) {
  await rm(`${manifestPath}.tmp`, { force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
