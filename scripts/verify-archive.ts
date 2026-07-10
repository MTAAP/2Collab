import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "2collab-archive-verify-"));
const firstArchive = join(temporaryRoot, "first.tar.gz");
const secondArchive = join(temporaryRoot, "second.tar.gz");
const probePath = join(root, "README.md");
const originalTimes = await stat(probePath);

async function buildArchive(outputPath: string): Promise<void> {
  const process = Bun.spawn(["bun", "run", "scripts/archive.ts", outputPath], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(process.stderr).text();
    throw new Error(`Archive build failed with exit ${exitCode}: ${stderr.trim()}`);
  }
}

try {
  await buildArchive(firstArchive);
  await utimes(probePath, new Date(946_684_800_000), new Date(946_684_800_000));
  await buildArchive(secondArchive);

  const [firstBytes, secondBytes] = await Promise.all([
    readFile(firstArchive),
    readFile(secondArchive),
  ]);
  if (!firstBytes.equals(secondBytes)) {
    throw new Error("Archive bytes changed after source mtime perturbation");
  }

  console.log(`Verified deterministic archive output (${firstBytes.byteLength} bytes)`);
} finally {
  await utimes(probePath, originalTimes.atime, originalTimes.mtime);
  await rm(temporaryRoot, { force: true, recursive: true });
}
