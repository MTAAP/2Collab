import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";

type AuditFile = {
  absolutePath: string;
  repositoryPath: string;
  size: number;
};

const root = resolve(import.meta.dir, "..");
const canonicalProductSpec = "docs/product/PRODUCT-SPEC.md";
const ignoredDirectories = new Set([
  ".git",
  ".worktrees",
  ".superpowers",
  "coverage",
  "data",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const forbiddenDirectories = new Set(["credentials", "runner-state", "transcripts"]);
const forbiddenNames = new Set([
  ".DS_Store",
  ".env",
  "package-lock.json",
  "pnpm-lock.yaml",
  "turbo.json",
  "yarn.lock",
]);
const textExtensions = new Set([
  ".css",
  ".example",
  ".html",
  ".json",
  ".md",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const maximumShippedFileBytes = 12 * 1024 * 1024;
const errors: string[] = [];

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function compareBytes(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function report(message: string): void {
  errors.push(message);
}

async function collectFiles(directory = root): Promise<AuditFile[]> {
  const files: AuditFile[] = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const repositoryPath = toPosixPath(relative(root, absolutePath));

    if (entry.isSymbolicLink()) {
      report(`Symbolic link is not permitted: ${repositoryPath}`);
      continue;
    }

    if (entry.isDirectory()) {
      if (forbiddenDirectories.has(entry.name) && !repositoryPath.includes("/")) {
        report(`Sensitive runtime directory is present: ${repositoryPath}`);
      } else if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await collectFiles(absolutePath)));
      }
      continue;
    }

    if (!entry.isFile()) {
      report(`Non-regular filesystem entry is present: ${repositoryPath}`);
      continue;
    }

    const metadata = await lstat(absolutePath);
    if ((metadata.mode & 0o002) !== 0) {
      report(`World-writable file is not permitted: ${repositoryPath}`);
    }
    if (metadata.size > maximumShippedFileBytes) {
      report(`Unexpected file larger than 12 MiB: ${repositoryPath}`);
    }
    if (forbiddenNames.has(entry.name) || entry.name.startsWith("._")) {
      report(`Generated or private file is present: ${repositoryPath}`);
    }
    if (entry.name.startsWith(".env.") && entry.name !== ".env.example") {
      report(`Environment file other than .env.example is present: ${repositoryPath}`);
    }

    files.push({ absolutePath, repositoryPath, size: metadata.size });
  }

  return files;
}

function isTextFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return (
    name === "LICENSE" ||
    name === ".editorconfig" ||
    name === ".gitattributes" ||
    name === ".gitignore" ||
    name === ".dockerignore" ||
    textExtensions.has(extname(name))
  );
}

function scanText(path: string, text: string): void {
  const backslash = String.fromCharCode(92);
  const machinePathPatterns = [
    /\/Users\/[A-Za-z0-9._-]+\//g,
    /\/home\/[A-Za-z0-9._-]+\//g,
    /file:\/\//gi,
    /vscode:\/\//gi,
  ];
  for (const pattern of machinePathPatterns) {
    if (pattern.test(text)) {
      report(`Machine-specific absolute path or URI in ${path}`);
      break;
    }
  }
  if (path !== "scripts/audit-public.ts") {
    const windowsPathPattern = new RegExp(
      `(?:^|[\\s"'\\x60(])(?:[A-Za-z]:${backslash.repeat(2)}|${backslash.repeat(4)})[^\\s"'\\x60)]+`,
      "gm",
    );
    if (windowsPathPattern.test(text)) {
      report(`Machine-specific Windows path in ${path}`);
    }
  }

  const privateKeyMarker = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  const secretPatterns = [
    new RegExp(privateKeyMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    /AKIA[0-9A-Z]{16}/,
    /gh[opurs]_[A-Za-z0-9]{36,}/,
    /xox[baprs]-[A-Za-z0-9-]{20,}/,
  ];
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) {
      report(`Credential-like content in ${path}`);
      break;
    }
  }

  if (text.includes("\r\n")) {
    report(`CRLF line endings are not permitted: ${path}`);
  }

  if (path !== canonicalProductSpec) {
    const placeholderMarkers = [
      ["TO", "DO"],
      ["T", "BD"],
      ["FIX", "ME"],
    ].map((parts) => parts.join(""));
    for (const line of text.split("\n")) {
      const mentionedMarkers = placeholderMarkers.filter((marker) =>
        new RegExp(`\\b${marker}\\b`).test(line),
      );
      if (mentionedMarkers.length > 0 && mentionedMarkers.length !== placeholderMarkers.length) {
        report(`Placeholder marker ${mentionedMarkers.join(", ")} in ${path}`);
      }
    }
  }
}

function markdownWithoutCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function githubSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

function markdownAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of markdownWithoutCode(markdown).split("\n")) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const base = githubSlug(match[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

async function hasExactCase(absolutePath: string): Promise<boolean> {
  const repositoryPath = relative(root, absolutePath);
  if (repositoryPath.startsWith("..") || resolve(absolutePath) === root) {
    return false;
  }

  let current = root;
  for (const component of repositoryPath.split(sep)) {
    const names = await readdir(current);
    if (!names.includes(component)) {
      return false;
    }
    current = join(current, component);
  }
  return true;
}

async function auditMarkdown(file: AuditFile, markdown: string): Promise<void> {
  const source = markdownWithoutCode(markdown);
  const targets: string[] = [];
  const inlineLink = /!?\[[^\]]*\]\(\s*([^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  const referenceLink = /^\s*\[[^\]]+\]:\s*([^\s]+).*$/gm;

  for (const pattern of [inlineLink, referenceLink]) {
    for (const match of source.matchAll(pattern)) {
      targets.push(match[1].replace(/^<|>$/g, ""));
    }
  }

  for (const target of targets) {
    if (/^(?:https?:|mailto:)/i.test(target)) {
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
      report(`Unsupported Markdown link scheme in ${file.repositoryPath}: ${target}`);
      continue;
    }

    const [pathAndQuery, encodedFragment] = target.split("#", 2);
    const encodedPath = pathAndQuery.split("?", 1)[0];
    let decodedPath: string;
    let fragment: string | undefined;
    try {
      decodedPath = decodeURIComponent(encodedPath);
      fragment = encodedFragment ? decodeURIComponent(encodedFragment).toLowerCase() : undefined;
    } catch {
      report(`Malformed URL encoding in ${file.repositoryPath}: ${target}`);
      continue;
    }

    if (decodedPath.startsWith("/") || decodedPath.includes("\\")) {
      report(`Non-relative Markdown link in ${file.repositoryPath}: ${target}`);
      continue;
    }

    const destination =
      decodedPath.length === 0
        ? file.absolutePath
        : resolve(dirname(file.absolutePath), decodedPath);
    const relativeDestination = relative(root, destination);
    if (relativeDestination.startsWith("..") || relativeDestination === "") {
      report(
        `Markdown link escapes or ambiguously targets repository root in ${file.repositoryPath}: ${target}`,
      );
      continue;
    }

    const destinationStat = await lstat(destination).catch(() => undefined);
    if (!destinationStat || (!destinationStat.isFile() && !destinationStat.isDirectory())) {
      report(`Broken Markdown link in ${file.repositoryPath}: ${target}`);
      continue;
    }
    if (!(await hasExactCase(destination))) {
      report(`Case-mismatched Markdown link in ${file.repositoryPath}: ${target}`);
      continue;
    }

    if (fragment && destinationStat.isFile() && extname(destination) === ".md") {
      const anchors = markdownAnchors(await readFile(destination, "utf8"));
      if (!anchors.has(fragment)) {
        report(`Missing Markdown anchor in ${file.repositoryPath}: ${target}`);
      }
    }
  }
}

function pngMetadataText(bytes: Buffer): string[] {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < signature.length || !bytes.subarray(0, 8).equals(signature)) {
    return [];
  }

  const text: string[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) {
      break;
    }
    const data = bytes.subarray(start, end);

    if (type === "tEXt" || type === "eXIf") {
      text.push(data.toString("utf8"));
    } else if (type === "zTXt") {
      const separator = data.indexOf(0);
      if (separator >= 0 && separator + 2 <= data.length) {
        try {
          text.push(inflateSync(data.subarray(separator + 2)).toString("utf8"));
        } catch {
          text.push(data.toString("utf8"));
        }
      }
    } else if (type === "iTXt") {
      const keywordEnd = data.indexOf(0);
      if (keywordEnd >= 0 && keywordEnd + 3 <= data.length) {
        const compressed = data[keywordEnd + 1] === 1;
        const languageEnd = data.indexOf(0, keywordEnd + 3);
        const translatedEnd = languageEnd >= 0 ? data.indexOf(0, languageEnd + 1) : -1;
        if (translatedEnd >= 0) {
          const payload = data.subarray(translatedEnd + 1);
          if (compressed) {
            try {
              text.push(inflateSync(payload).toString("utf8"));
            } catch {
              text.push(payload.toString("utf8"));
            }
          } else {
            text.push(payload.toString("utf8"));
          }
        }
      }
    }
    offset = end + 4;
  }
  return text;
}

async function auditPackageJson(): Promise<void> {
  const packageJsonPath = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    packageManager?: string;
    private?: boolean;
    scripts?: Record<string, string>;
  };

  if (packageJson.private !== true) {
    report("package.json must set private to true");
  }
  if (packageJson.packageManager !== "bun@1.3.10") {
    report("package.json must pin packageManager to bun@1.3.10");
  }

  const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  for (const [group, dependencies] of Object.entries({
    dependencies: packageJson.dependencies ?? {},
    devDependencies: packageJson.devDependencies ?? {},
  })) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (!exactVersion.test(version)) {
        report(`${group}.${name} is not pinned to one exact registry version: ${version}`);
      }
    }
  }

  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    if (/\b(?:npm|pnpm|yarn|npx)\b/.test(command) || /rm\s+-rf/.test(command)) {
      report(`Package script ${name} uses a non-portable or legacy command: ${command}`);
    }
  }
}

const files = (await collectFiles()).sort((left, right) =>
  compareBytes(left.repositoryPath, right.repositoryPath),
);
const normalizedPaths = new Map<string, string>();

for (const file of files) {
  const normalized = file.repositoryPath.normalize("NFC").toLowerCase();
  const collision = normalizedPaths.get(normalized);
  if (collision && collision !== file.repositoryPath) {
    report(`Case or Unicode-normalization path collision: ${collision} and ${file.repositoryPath}`);
  } else {
    normalizedPaths.set(normalized, file.repositoryPath);
  }

  if (isTextFile(file.repositoryPath) && file.size <= maximumShippedFileBytes) {
    const text = await readFile(file.absolutePath, "utf8");
    scanText(file.repositoryPath, text);
    if (file.repositoryPath.endsWith(".md")) {
      await auditMarkdown(file, text);
    }
  }

  if (file.repositoryPath.endsWith(".png")) {
    const metadata = pngMetadataText(await readFile(file.absolutePath)).join("\n");
    if (metadata.length > 0) {
      scanText(`${file.repositoryPath} metadata`, metadata);
    }
  }
}

const mockupDirectory = join(root, "docs", "ux", "mockups");
const mockupStat = await lstat(mockupDirectory).catch(() => undefined);
if (!mockupStat?.isDirectory()) {
  report("Approved mockup directory is missing: docs/ux/mockups");
} else {
  const pngs = (await readdir(mockupDirectory)).filter((name) => name.endsWith(".png"));
  if (pngs.length !== 14) {
    report(`Expected 14 approved mockup PNGs, found ${pngs.length}`);
  }
}

await auditPackageJson();

if (errors.length > 0) {
  for (const error of errors.sort(compareBytes)) {
    console.error(`PUBLIC_AUDIT: ${error}`);
  }
  console.error(`Public audit failed with ${errors.length} finding(s)`);
  process.exitCode = 1;
} else {
  console.log(`Public audit passed for ${files.length} regular files`);
}
