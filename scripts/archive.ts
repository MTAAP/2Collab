import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createDeterministicGzip, createUstarArchive } from "./lib/archive.ts";

const ARCHIVE_EPOCH = 1_783_641_600;
const root = resolve(import.meta.dir, "..");
const manifestPath = join(root, "MANIFEST.sha256");

function parseManifest(text: string): string[] {
  const paths: string[] = [];
  for (const [index, line] of text.trimEnd().split("\n").entries()) {
    const match = /^[0-9a-f]{64} {2}([A-Za-z0-9._/-]+)$/.exec(line);
    if (!match) {
      throw new Error(`Malformed MANIFEST.sha256 line ${index + 1}`);
    }
    paths.push(match[1]);
  }
  return paths;
}

const outputArgument = process.argv[2];
if (!outputArgument) {
  throw new Error(
    "Usage: bun run scripts/archive.ts <output-path/2Collab-repository-seed-YYYY-MM-DD.tar.gz>",
  );
}

const outputPath = isAbsolute(outputArgument) ? outputArgument : resolve(root, outputArgument);
if (!outputPath.endsWith(".tar.gz")) {
  throw new Error("Archive output path must end with .tar.gz");
}
const outputRelativeToRoot = relative(root, outputPath);
if (!outputRelativeToRoot.startsWith("..") && !isAbsolute(outputRelativeToRoot)) {
  throw new Error("Archive output must be outside the repository seed root");
}

const manifestText = await readFile(manifestPath, "utf8");
const inventory = [...parseManifest(manifestText), "MANIFEST.sha256"];
const entries = await Promise.all(
  inventory.map(async (path) => ({
    bytes: new Uint8Array(await readFile(join(root, path))),
    path,
  })),
);
const compressed = createDeterministicGzip(createUstarArchive(entries, ARCHIVE_EPOCH));
await writeFile(outputPath, compressed, { mode: 0o644 });

const digest = createHash("sha256").update(compressed).digest("hex");
await writeFile(`${outputPath}.sha256`, `${digest}  ${basename(outputPath)}\n`, {
  encoding: "utf8",
  mode: 0o644,
});

console.log(`Wrote ${entries.length} files to ${outputPath}`);
console.log(`SHA-256 ${digest}`);
