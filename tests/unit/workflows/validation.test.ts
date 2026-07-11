import { describe, expect, test } from "bun:test";
import type { TeamRunTemplateVersion } from "../../../src/shared/contracts/templates.ts";
import { validateWorkflow } from "../../../src/server/modules/workflows/validation.ts";
import { validDefinition } from "../../fixtures/workflows/valid.ts";

const templates = new Map<string, TeamRunTemplateVersion>([
  [
    "run_template_implement_v1",
    {
      id: "run_template_implement_v1",
      templateKey: "implement",
      version: 1,
      definition: {
        name: "Implement",
        coreInstructions: "Implement the goal.",
        variables: [],
        resultKeys: ["READY_FOR_REVIEW"],
        repositoryMode: "MUTATING",
        minimumAssurance: "ADVISORY",
        gateSets: [],
        maximumAttempts: 2,
        absoluteDeadlineMs: 1_000,
      },
      semanticHash: "a".repeat(64),
    },
  ],
  [
    "run_template_review_v1",
    {
      id: "run_template_review_v1",
      templateKey: "review",
      version: 1,
      definition: {
        name: "Review",
        coreInstructions: "Review the goal.",
        variables: [],
        resultKeys: ["APPROVED", "CHANGES_REQUESTED"],
        repositoryMode: "INSPECT_ONLY",
        minimumAssurance: "ADVISORY",
        gateSets: [],
        maximumAttempts: 1,
        absoluteDeadlineMs: 1_000,
      },
      semanticHash: "b".repeat(64),
    },
  ],
]);

describe("authoritative workflow validation", () => {
  test("accepts the bounded canonical fixture", () => {
    expect(validateWorkflow(validDefinition, templates)).toEqual([]);
  });

  test.each([
    [
      {
        ...validDefinition,
        nodes: validDefinition.nodes.filter((node) => node.kind !== "TERMINAL"),
      },
      "WORKFLOW_TERMINAL_REQUIRED",
    ],
    [{ ...validDefinition, cycleBounds: {} }, "WORKFLOW_CYCLE_BOUND_REQUIRED"],
    [{ ...validDefinition, maximumRunCount: 0 }, "WORKFLOW_BOUND_INVALID"],
    [
      {
        ...validDefinition,
        nodes: [
          ...validDefinition.nodes,
          {
            kind: "JOIN" as const,
            key: "race",
            branchKeys: ["review"],
            policy: "ANY" as const,
            acceptedResultKeys: ["APPROVED"],
            fallbackTargetKey: "failed",
          },
        ],
      },
      "WORKFLOW_JOIN_INVALID",
    ],
  ])("rejects invalid graphs with %s", (definition, code) => {
    expect(validateWorkflow(definition, templates).map((item) => item.code)).toContain(code);
  });

  test("rejects mutating work in a parallel group", () => {
    const definition = {
      ...validDefinition,
      nodes: [
        ...validDefinition.nodes,
        { kind: "PARALLEL_SPLIT" as const, key: "split", branchKeys: ["implement", "review"] },
      ],
    };
    expect(validateWorkflow(definition, templates).map((item) => item.code)).toContain(
      "WORKFLOW_PARALLEL_MUTATION_FORBIDDEN",
    );
  });
});
