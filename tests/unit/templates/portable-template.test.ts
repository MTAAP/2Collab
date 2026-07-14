import { describe, expect, test } from "bun:test";
import { sanitizeRunTemplate } from "../../../src/server/modules/templates/run-templates.ts";

export const portableRunTemplate = {
  name: "Review",
  coreInstructions: "Review the published revision.",
  variables: [{ key: "goal", type: "STRING", required: true }],
  resultKeys: ["APPROVED", "CHANGES_REQUESTED"],
  repositoryMode: "INSPECT_ONLY",
  minimumAssurance: "ADVISORY",
  contextRecipeId: "recipe_review",
  gateSets: ["REVIEW"],
  maximumAttempts: 2,
  absoluteDeadlineMs: 900_000,
} as const;

describe("portable Team Run Templates", () => {
  test("accepts a bounded portable definition", () => {
    expect(sanitizeRunTemplate(portableRunTemplate)).toEqual(portableRunTemplate);
  });

  test.each([
    ["privateRunnerId", "runner_private"],
    ["personalRunPresetId", "preset_private"],
    ["profileVersionId", "profile_private"],
    ["executable", "/usr/local/bin/claude"],
    ["arguments", ["--dangerously-skip-permissions"]],
    ["environment", { TOKEN: "secret" }],
    ["credential", "secret"],
    ["documentWriteGrantId", "grant_private"],
  ])("rejects private execution field %s", (key, value) => {
    expect(() => sanitizeRunTemplate({ ...portableRunTemplate, [key]: value })).toThrow(
      "TEMPLATE_PRIVATE_EXECUTION_DATA",
    );
  });
});
