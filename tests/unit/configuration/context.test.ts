import { describe, expect, test } from "bun:test";
import {
  type AuthorizedContextCandidate,
  assembleBootstrapEnvelope,
  type ContextRecipeVersion,
} from "../../../src/server/modules/context/context-recipes.ts";

const recipe: ContextRecipeVersion = {
  id: "recipe_1",
  version: 1,
  projectId: "project_1",
  digest: "a".repeat(64),
  perCategoryLimits: {
    COORDINATION: 1,
    SOURCE: 2,
    PUBLISHED_GIT_REFERENCE: 1,
    INSTRUCTION: 1,
    CHECKPOINT: 1,
  },
  maximumReferences: 3,
  maximumPreviewBytes: 7,
  freshnessSeconds: 30,
  predecessorPolicy: "LATEST_CHECKPOINT",
};

function candidate(
  overrides: Partial<AuthorizedContextCandidate> = {},
): AuthorizedContextCandidate {
  return {
    category: "SOURCE",
    referenceId: "issue_1",
    canonicalKey: "github:issue:1",
    observedRevision: "1",
    observedAt: 90,
    availability: "AVAILABLE",
    authority: "AUTHORIZED",
    priority: 10,
    authoredPreview: "alpha",
    ...overrides,
  };
}

describe("reference-first context recipes", () => {
  test("deduplicates deterministically, applies category and total bounds, and reports omissions", () => {
    const result = assembleBootstrapEnvelope(
      recipe,
      [
        candidate({ referenceId: "issue_2", canonicalKey: "github:issue:2", priority: 5 }),
        candidate({ referenceId: "issue_1_old", observedRevision: "0", observedAt: 80 }),
        candidate({ referenceId: "issue_1_new", observedRevision: "2", priority: 20 }),
        candidate({
          category: "COORDINATION",
          referenceId: "coordination_1",
          canonicalKey: "coordination:1",
          priority: 30,
        }),
        candidate({
          category: "PUBLISHED_GIT_REFERENCE",
          referenceId: "published_1",
          canonicalKey: "published:1",
          priority: 1,
        }),
      ],
      100,
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.references.map((reference) => reference.referenceId)).toEqual([
      "coordination_1",
      "issue_1_new",
      "issue_2",
    ]);
    expect(result.value.omissions.map((omission) => omission.reason)).toContain("DUPLICATE");
    expect(result.value.omissions.map((omission) => omission.reason)).toContain("TOTAL_LIMIT");
  });

  test("never turns forbidden or unavailable candidates into access and reports freshness honestly", () => {
    const result = assembleBootstrapEnvelope(
      { ...recipe, maximumReferences: 4, maximumPreviewBytes: 32 },
      [
        candidate({ referenceId: "fresh", canonicalKey: "source:fresh" }),
        candidate({
          referenceId: "stale",
          canonicalKey: "source:stale",
          observedAt: 69,
        }),
        candidate({
          referenceId: "forbidden",
          canonicalKey: "source:forbidden",
          authority: "FORBIDDEN",
        }),
        candidate({
          referenceId: "missing",
          canonicalKey: "source:missing",
          availability: "UNAVAILABLE",
        }),
      ],
      100,
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.references).toMatchObject([
      { referenceId: "fresh", status: "FRESH" },
      { referenceId: "stale", status: "STALE" },
    ]);
    expect(result.value.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ referenceId: "forbidden", reason: "FORBIDDEN" }),
        expect.objectContaining({ referenceId: "missing", reason: "UNAVAILABLE" }),
      ]),
    );
  });

  test("bounds authored previews by UTF-8 bytes without splitting a code point", () => {
    const result = assembleBootstrapEnvelope(
      { ...recipe, maximumReferences: 1, maximumPreviewBytes: 5 },
      [candidate({ authoredPreview: "Aé€B" })],
      100,
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.references[0]?.authoredPreview).toBe("Aé");
    expect(Buffer.byteLength(result.value.references[0]?.authoredPreview ?? "")).toBe(3);
    expect(JSON.stringify(result.value)).not.toMatch(/body|diff|transcript|absolutePath/i);
  });

  test("fails closed on malformed candidate provenance instead of emitting unsafe references", () => {
    for (const malformed of [
      candidate({ referenceId: "" }),
      candidate({ canonicalKey: "" }),
      candidate({ observedRevision: "" }),
      candidate({ observedAt: -1 }),
      candidate({ priority: Number.POSITIVE_INFINITY }),
      candidate({ authoredPreview: "x".repeat(65_537) }),
    ]) {
      expect(assembleBootstrapEnvelope(recipe, [malformed], 100)).toMatchObject({
        ok: false,
        error: { code: "CONTEXT_CANDIDATE_INVALID" },
      });
    }
    expect(
      assembleBootstrapEnvelope(
        {
          ...recipe,
          perCategoryLimits: { ...recipe.perCategoryLimits, EXECUTABLE_BODY: 1 } as never,
        },
        [],
        100,
      ),
    ).toMatchObject({ ok: false, error: { code: "CONTEXT_RECIPE_INVALID" } });
  });

  test("emits at most one durable entry for the same category and reference identifier", () => {
    const result = assembleBootstrapEnvelope(
      recipe,
      [candidate({ observedRevision: "2", priority: 20 }), candidate({ observedRevision: "1" })],
      100,
    );
    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.references).toHaveLength(1);
    expect(result.value.omissions).toHaveLength(0);
  });
});
