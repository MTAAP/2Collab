import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  EXPECTED_OUTLINE_STORE_IDS,
  scanForbiddenCanaries,
} from "../../src/server/modules/documents/revocation.ts";
test("scans the Foundation closed real-store inventory for encoded forbidden Outline bodies and tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "outline-canary-"));
  try {
    for (const id of EXPECTED_OUTLINE_STORE_IDS)
      await writeFile(join(root, id), `safe-store=${id}`, { mode: 0o600 });
    const stores = await Promise.all(
      EXPECTED_OUTLINE_STORE_IDS.map(async (id) => ({
        id,
        readable: true,
        bytes: await readFile(join(root, id), "utf8"),
      })),
    );
    const clean = scanForbiddenCanaries(stores, ["fetched-body-canary", "access-token-canary"]);
    expect(clean).toEqual({ ok: true, value: { scanned: EXPECTED_OUTLINE_STORE_IDS.length } });
    const dirty = scanForbiddenCanaries(
      stores.map((store) =>
        store.id === "runner-outbox"
          ? { ...store, bytes: Buffer.from("fetched-body-canary").toString("base64") }
          : store,
      ),
      ["fetched-body-canary"],
    );
    expect(dirty.ok).toBe(false);
    expect(scanForbiddenCanaries(stores.slice(1), ["fetched-body-canary"]).ok).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
