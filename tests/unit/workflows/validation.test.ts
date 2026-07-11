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

  test("rejects duplicate and ambiguous typed edges", () => {
    const duplicate = {
      ...validDefinition,
      transitions: [
        ...validDefinition.transitions,
        { from: "start", resultKey: "STARTED", to: "implement" },
      ],
    };
    expect(validateWorkflow(duplicate, templates).map((item) => item.code)).toContain(
      "WORKFLOW_TRANSITION_DUPLICATE",
    );

    const ambiguous = {
      ...validDefinition,
      transitions: [
        ...validDefinition.transitions,
        { from: "start", resultKey: "STARTED", to: "failed" },
      ],
    };
    expect(validateWorkflow(ambiguous, templates).map((item) => item.code)).toContain(
      "WORKFLOW_TRANSITION_AMBIGUOUS",
    );
  });

  test("requires exhaustive, result-compatible Agent Run and Result Router paths", () => {
    const missingAgentResult = {
      ...validDefinition,
      transitions: validDefinition.transitions.filter(
        (edge) => !(edge.from === "review" && edge.resultKey === "APPROVED"),
      ),
    };
    expect(validateWorkflow(missingAgentResult, templates).map((item) => item.code)).toContain(
      "WORKFLOW_RESULT_TRANSITION_REQUIRED",
    );

    const missingRouterResult = {
      ...validDefinition,
      nodes: validDefinition.nodes.map((node) =>
        node.kind === "RESULT_ROUTER" ? { ...node, routes: { APPROVED: "done" } } : node,
      ),
    };
    expect(validateWorkflow(missingRouterResult, templates).map((item) => item.code)).toContain(
      "WORKFLOW_RESULT_ROUTE_REQUIRED",
    );

    const unknownRouterResult = {
      ...validDefinition,
      nodes: validDefinition.nodes.map((node) =>
        node.kind === "RESULT_ROUTER"
          ? { ...node, routes: { ...node.routes, UNKNOWN: "done" } }
          : node,
      ),
      transitions: [
        ...validDefinition.transitions,
        { from: "review_result", resultKey: "UNKNOWN", to: "done" },
      ],
    };
    expect(validateWorkflow(unknownRouterResult, templates).map((item) => item.code)).toContain(
      "WORKFLOW_RESULT_INCOMPATIBLE",
    );
  });

  test("requires every human choice to have one exact transition", () => {
    const definition = {
      ...validDefinition,
      nodes: validDefinition.nodes.map((node) =>
        node.key === "review_result"
          ? {
              kind: "HUMAN_DECISION" as const,
              key: "review_result",
              choices: ["APPROVE", "REJECT"],
            }
          : node,
      ),
      transitions: validDefinition.transitions.filter(
        (edge) => edge.from !== "review_result" || edge.resultKey === "APPROVE",
      ),
    };
    expect(validateWorkflow(definition, templates).map((item) => item.code)).toContain(
      "WORKFLOW_DECISION_TRANSITION_REQUIRED",
    );
  });

  test("rejects reachable paths that cannot reach a terminal", () => {
    const definition = {
      ...validDefinition,
      nodes: [
        ...validDefinition.nodes,
        {
          kind: "HUMAN_DECISION" as const,
          key: "trap",
          choices: ["RETRY"],
        },
      ],
      transitions: [
        ...validDefinition.transitions,
        { from: "review_result", resultKey: "APPROVED", to: "trap" },
        { from: "trap", resultKey: "RETRY", to: "trap" },
      ].filter(
        (edge, index, edges) =>
          edge.from !== "review_result" ||
          edge.resultKey !== "APPROVED" ||
          index === edges.length - 2,
      ),
      cycleBounds: { ...validDefinition.cycleBounds, trap: 1 },
    };
    expect(validateWorkflow(definition, templates).map((item) => item.code)).toContain(
      "WORKFLOW_TERMINAL_PATH_REQUIRED",
    );
  });

  test("requires cycle bounds to name real closed cycles", () => {
    const fakeBound = {
      ...validDefinition,
      cycleBounds: { "start->done": 2 },
    };
    const codes = validateWorkflow(fakeBound, templates).map((item) => item.code);
    expect(codes).toContain("WORKFLOW_CYCLE_BOUND_INVALID");
    expect(codes).toContain("WORKFLOW_CYCLE_BOUND_REQUIRED");
  });

  test("validates parallel joins and exact policy transitions", () => {
    const parallelDefinition = {
      inputs: [],
      nodes: [
        { kind: "START" as const, key: "start" },
        { kind: "PARALLEL_SPLIT" as const, key: "split", branchKeys: ["review_a", "review_b"] },
        {
          kind: "AGENT_RUN" as const,
          key: "review_a",
          runTemplateVersionId: "run_template_review_v1",
          resultKeys: ["APPROVED", "CHANGES_REQUESTED"],
        },
        {
          kind: "AGENT_RUN" as const,
          key: "review_b",
          runTemplateVersionId: "run_template_review_v1",
          resultKeys: ["APPROVED", "CHANGES_REQUESTED"],
        },
        {
          kind: "JOIN" as const,
          key: "join",
          branchKeys: ["review_a", "review_b"],
          policy: "ANY" as const,
          acceptedResultKeys: ["APPROVED"],
          fallbackTargetKey: "failed",
          remainderPolicy: "CANCEL_REMAINDER" as const,
        },
        { kind: "TERMINAL" as const, key: "done", outcome: "COMPLETED" as const },
        { kind: "TERMINAL" as const, key: "failed", outcome: "FAILED" as const },
      ],
      transitions: [
        { from: "start", resultKey: "STARTED", to: "split" },
        { from: "join", resultKey: "APPROVED", to: "done" },
      ],
      maximumRunCount: 2,
      cycleBounds: {},
      maximumParallelBranches: 2,
      maximumConcurrency: 2,
      absoluteDeadlineMs: 1_000,
    };
    expect(validateWorkflow(parallelDefinition, templates).map((item) => item.code)).toContain(
      "WORKFLOW_JOIN_FALLBACK_REQUIRED",
    );

    const allDefinition = {
      ...parallelDefinition,
      nodes: parallelDefinition.nodes.map((node) =>
        node.kind === "JOIN"
          ? { ...node, policy: "ALL" as const, remainderPolicy: undefined }
          : node,
      ),
      transitions: parallelDefinition.transitions.filter((edge) => edge.from !== "join"),
    };
    expect(validateWorkflow(allDefinition, templates).map((item) => item.code)).toContain(
      "WORKFLOW_JOIN_ALL_TRANSITION_REQUIRED",
    );
  });
});
