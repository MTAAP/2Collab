import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { assembleEffectiveInstructions } from "../../src/runner/instruction-assembly.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

const bootstrap = {
  schemaVersion: 1 as const,
  contextRecipe: { id: "recipe_1", version: 1, digest: "a".repeat(64) },
  references: [
    {
      category: "SOURCE" as const,
      referenceId: "issue_1",
      observedRevision: "revision_1",
      status: "FRESH" as const,
      authoredPreview: "Authored excerpt.",
    },
  ],
  omissions: [],
};
const layers = {
  teamCore: "Team core instructions.",
  typedVariables: { reviewDepth: "DEEP", stopOnConflict: true },
  personalAddendum: "Personal addendum.",
  runGoal: "Complete the run.",
  authoredRunInput: "This run input.",
};
const configurationDigest = "b".repeat(64);
const contextEnvelopeDigest = sha256(bootstrap);
const instructions = {
  schemaVersion: 1 as const,
  configurationDigest,
  contextEnvelopeDigest,
  assemblyDigest: sha256({
    configurationDigest,
    envelopeDigest: contextEnvelopeDigest,
    authoredRunInput: layers.authoredRunInput,
  }),
  layers,
};

test("runner assembles labelled immutable layers and reference-first context", () => {
  const result = assembleEffectiveInstructions({ instructions, bootstrap });
  expect(result.ok).toBeTrue();
  if (!result.ok) throw new Error(result.error.code);
  expect(result.value).toContain("## Team core\n\nTeam core instructions.");
  expect(result.value).toContain(
    '## Typed variables\n\n{"reviewDepth":"DEEP","stopOnConflict":true}',
  );
  expect(result.value).toContain("## Personal addendum\n\nPersonal addendum.");
  expect(result.value).toContain("## This run\n\nComplete the run.");
  expect(result.value).toContain("## Authored run input\n\nThis run input.");
  expect(result.value).toContain("## Context references");
  expect(result.value).not.toMatch(/executable|environment|credential|absolutePath/i);
});

test("runner rejects changed instruction or context assembly digests", () => {
  expect(
    assembleEffectiveInstructions({
      instructions,
      bootstrap: { ...bootstrap, references: [] },
    }),
  ).toMatchObject({ ok: false, error: { code: "INSTRUCTION_DIGEST_MISMATCH" } });
  expect(
    assembleEffectiveInstructions({
      instructions: {
        ...instructions,
        layers: { ...layers, authoredRunInput: "Changed input." },
      },
      bootstrap,
    }),
  ).toMatchObject({ ok: false, error: { code: "INSTRUCTION_DIGEST_MISMATCH" } });
});
