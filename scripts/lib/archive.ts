export type ArchiveEntry = {
  bytes: Uint8Array;
  path: string;
};

const BLOCK_SIZE = 512;
const encoder = new TextEncoder();

function assertPortablePath(path: string): void {
  const encoded = encoder.encode(path);
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.includes("") ||
    segments.includes(".") ||
    segments.includes("..") ||
    encoded.length > 100 ||
    !/^[A-Za-z0-9._/-]+$/.test(path)
  ) {
    throw new Error(`Archive entry is not a portable relative path: ${path}`);
  }
}

function writeText(target: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = encoder.encode(value);
  if (encoded.length > length) {
    throw new Error(`Tar header value is too long: ${value}`);
  }
  target.set(encoded, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  writeText(target, offset, length, `${encoded}\0`);
}

function createHeader(entry: ArchiveEntry, epochSeconds: number): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  assertPortablePath(entry.path);
  writeText(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.bytes.byteLength);
  writeOctal(header, 136, 12, epochSeconds);
  header.fill(0x20, 148, 156);
  writeText(header, 156, 1, "0");
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeText(header, 265, 32, "root");
  writeText(header, 297, 32, "root");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);

  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

export function createUstarArchive(
  entries: readonly ArchiveEntry[],
  epochSeconds: number,
): Uint8Array {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0) {
    throw new Error("Archive epoch must be a non-negative integer");
  }

  const sortedEntries = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const seen = new Set<string>();
  const chunks: Uint8Array[] = [];
  let totalLength = BLOCK_SIZE * 2;

  for (const entry of sortedEntries) {
    assertPortablePath(entry.path);
    const foldedPath = entry.path.toLocaleLowerCase("en-US");
    if (seen.has(foldedPath)) {
      throw new Error(`Archive paths collide by case: ${entry.path}`);
    }
    seen.add(foldedPath);

    const header = createHeader(entry, epochSeconds);
    const paddingLength = (BLOCK_SIZE - (entry.bytes.byteLength % BLOCK_SIZE)) % BLOCK_SIZE;
    const padding = new Uint8Array(paddingLength);
    chunks.push(header, entry.bytes, padding);
    totalLength += header.byteLength + entry.bytes.byteLength + paddingLength;
  }

  chunks.push(new Uint8Array(BLOCK_SIZE * 2));
  const archive = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

export function createDeterministicGzip(bytes: Uint8Array): Uint8Array {
  const compressed = new Uint8Array(Bun.gzipSync(Uint8Array.from(bytes)));
  compressed.fill(0, 4, 8);
  compressed[9] = 255;
  return compressed;
}
