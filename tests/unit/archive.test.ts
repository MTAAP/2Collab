import { describe, expect, test } from "bun:test";
import { createDeterministicGzip, createUstarArchive } from "../../scripts/lib/archive.ts";

describe("deterministic archive helpers", () => {
  test("produces identical gzip bytes for identical entries", () => {
    const entries = [
      { bytes: new TextEncoder().encode("alpha\n"), path: "README.md" },
      { bytes: new TextEncoder().encode("beta\n"), path: "docs/START-HERE.md" },
    ];

    const first = createDeterministicGzip(createUstarArchive(entries, 1_783_641_600));
    const second = createDeterministicGzip(createUstarArchive(entries, 1_783_641_600));

    expect(first).toEqual(second);
  });

  test("sorts entries and emits a portable ustar header", () => {
    const archive = createUstarArchive(
      [
        { bytes: new TextEncoder().encode("second"), path: "z.txt" },
        { bytes: new TextEncoder().encode("first"), path: "a.txt" },
      ],
      1_783_641_600,
    );
    const name = new TextDecoder().decode(archive.slice(0, 100)).replaceAll("\0", "");
    const magic = new TextDecoder().decode(archive.slice(257, 263));

    expect(name).toBe("a.txt");
    expect(magic).toBe("ustar\0");
    expect(archive.slice(-1_024)).toEqual(new Uint8Array(1_024));
  });

  test("rejects paths that cannot be safely extracted", () => {
    expect(() =>
      createUstarArchive([{ bytes: new Uint8Array(), path: "../outside" }], 1_783_641_600),
    ).toThrow("portable relative path");
  });
});
