import type { WorkflowDefinition } from "../../../src/shared/contracts/workflow.ts";

export const validDefinition: WorkflowDefinition = {
  inputs: [{ key: "goal", type: "STRING", required: true }],
  nodes: [
    { kind: "START", key: "start" },
    {
      kind: "AGENT_RUN",
      key: "implement",
      runTemplateVersionId: "run_template_implement_v1",
      resultKeys: ["READY_FOR_REVIEW"],
    },
    {
      kind: "AGENT_RUN",
      key: "review",
      runTemplateVersionId: "run_template_review_v1",
      resultKeys: ["APPROVED", "CHANGES_REQUESTED"],
    },
    {
      kind: "RESULT_ROUTER",
      key: "review_result",
      sourceStepKey: "review",
      routes: { APPROVED: "done", CHANGES_REQUESTED: "implement" },
      fallbackTargetKey: "failed",
    },
    { kind: "TERMINAL", key: "done", outcome: "COMPLETED" },
    { kind: "TERMINAL", key: "failed", outcome: "FAILED" },
  ],
  transitions: [
    { from: "start", resultKey: "STARTED", to: "implement" },
    { from: "implement", resultKey: "READY_FOR_REVIEW", to: "review" },
    { from: "review", resultKey: "APPROVED", to: "review_result" },
    { from: "review", resultKey: "CHANGES_REQUESTED", to: "review_result" },
    { from: "review_result", resultKey: "APPROVED", to: "done" },
    { from: "review_result", resultKey: "CHANGES_REQUESTED", to: "implement" },
    { from: "review_result", resultKey: "FALLBACK", to: "failed" },
  ],
  maximumRunCount: 5,
  cycleBounds: { "implement->review->review_result": 2 },
  maximumParallelBranches: 2,
  maximumConcurrency: 2,
  absoluteDeadlineMs: 3_600_000,
};

export const validLayout = {
  nodes: validDefinition.nodes.map((node, index) => ({
    key: node.key,
    x: index * 180,
    y: 120,
    collapsed: false,
  })),
  viewport: { x: 0, y: 0, zoom: 1 },
  collapsedGroups: [],
} as const;
