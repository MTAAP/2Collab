import { expect, test } from "bun:test";
import { scanForbiddenCanaries } from "../../src/server/modules/documents/revocation.ts";
test("scans a closed supplied store inventory for encoded forbidden bodies and tokens", () => {
  const clean = scanForbiddenCanaries(
    [
      { id: "projection", bytes: JSON.stringify({ documentId: "doc", revision: "7" }) },
      { id: "audit", bytes: "OUTLINE_READ_ALLOWED" },
    ],
    ["fetched-body-canary", "access-token-canary"],
  );
  expect(clean).toEqual({ ok: true, value: { scanned: 2 } });
  const dirty = scanForbiddenCanaries(
    [{ id: "outbox", bytes: Buffer.from("fetched-body-canary").toString("base64") }],
    ["fetched-body-canary"],
  );
  expect(dirty.ok).toBe(false);
});
