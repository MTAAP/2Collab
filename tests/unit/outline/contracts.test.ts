import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  OutlineMutationSchema,
  prepareAuthoredDocumentPatch,
  validateAuthoredDocumentPatch,
} from "../../../src/shared/contracts/outline.ts";

test("rejects generic endpoints and bot-authored human edits", () => {
  expect(
    OutlineMutationSchema.safeParse({ kind: "RAW_API", path: "/documents.delete" }).success,
  ).toBe(false);
  expect(
    OutlineMutationSchema.safeParse({
      kind: "EDIT_DOCUMENT_AS_MEMBER",
      identity: { kind: "BOT" },
      documentId: "doc_a",
      authoredPatch: { format: "UNIFIED_TEXT_PATCH_V1", value: "x", digest: "a".repeat(64) },
    }).success,
  ).toBe(false);
});

test("accepts only bounded digest-bound unified patches", async () => {
  const value = "@@ -1,1 +1,1 @@\n-old\n+new";
  const valid = await validateAuthoredDocumentPatch({
    format: "UNIFIED_TEXT_PATCH_V1",
    value,
    digest: createHash("sha256").update(value).digest("hex"),
  });
  expect(valid.ok).toBe(true);
  expect(
    await validateAuthoredDocumentPatch({
      format: "UNIFIED_TEXT_PATCH_V1",
      value,
      digest: "0".repeat(64),
    }),
  ).toEqual(expect.objectContaining({ ok: false }));
});

test("accepts multiple unified patch hunks", async () => {
  const value = "@@ -1,1 +1,1 @@\n-old\n+new\n@@ -4,0 +4,1 @@\n+inserted";
  expect(
    await validateAuthoredDocumentPatch({
      format: "UNIFIED_TEXT_PATCH_V1",
      value,
      digest: createHash("sha256").update(value).digest("hex"),
    }),
  ).toMatchObject({ ok: true });
});

test("rejects patch hunks whose new offsets do not match the resulting document", () => {
  expect(
    prepareAuthoredDocumentPatch("first\nsecond", "@@ -1,1 +2,1 @@\n-first\n+changed"),
  ).toMatchObject({ ok: false, error: { code: "OUTLINE_PATCH_INVALID" } });
});
