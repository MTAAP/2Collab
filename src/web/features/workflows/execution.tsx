import { memo, useState } from "react";
import type { WorkflowDefinition } from "../../../shared/contracts/workflow.ts";

export type WorkflowExecutionViewModel = Readonly<{
  name: string;
  state: "ACTIVE" | "WAITING" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELLED";
  nodes: Readonly<Record<string, Readonly<{ state: string }>>>;
}>;

const ExecutionNode = memo(function ExecutionNode({
  nodeKey,
  state,
}: Readonly<{ nodeKey: string; state: string }>) {
  const label = `${nodeKey.charAt(0).toUpperCase()}${nodeKey.slice(1).replaceAll("-", " ")}`;
  return (
    <li data-state={state}>
      <button type="button" aria-label={`Open ${nodeKey}`}>
        {label}
      </button>
    </li>
  );
});

export function WorkflowExecutionView({
  execution,
  definition,
}: Readonly<{ execution: WorkflowExecutionViewModel; definition: WorkflowDefinition }>) {
  const terminal = ["COMPLETED", "FAILED", "CANCELLED"].includes(execution.state);
  return (
    <section aria-labelledby="workflow-title">
      <h2 id="workflow-title">{execution.name}</h2>
      <ol>
        {definition.nodes.map((node) => (
          <ExecutionNode
            key={node.key}
            nodeKey={node.key}
            state={execution.nodes[node.key]?.state ?? "PENDING"}
          />
        ))}
      </ol>
      {terminal ? <output data-testid="workflow-terminal">{execution.state}</output> : null}
    </section>
  );
}

const JOURNEY_DEFINITION: WorkflowDefinition = {
  inputs: [{ key: "goal", type: "STRING", required: true }],
  nodes: [
    { kind: "START", key: "start" },
    {
      kind: "AGENT_RUN",
      key: "implementation",
      runTemplateVersionId: "implementation_v1",
      resultKeys: ["READY_FOR_REVIEW"],
    },
    {
      kind: "PARALLEL_SPLIT",
      key: "parallel-reviews",
      branchKeys: ["claude-review", "codex-review"],
    },
    {
      kind: "AGENT_RUN",
      key: "claude-review",
      runTemplateVersionId: "claude_review_v1",
      resultKeys: ["CLEAN", "MAJOR_FINDING"],
    },
    {
      kind: "AGENT_RUN",
      key: "codex-review",
      runTemplateVersionId: "codex_review_v1",
      resultKeys: ["CLEAN", "MAJOR_FINDING"],
    },
    {
      kind: "JOIN",
      key: "review-join",
      branchKeys: ["claude-review", "codex-review"],
      policy: "ALL",
      acceptedResultKeys: ["CLEAN", "MAJOR_FINDING"],
      fallbackTargetKey: "human-review",
    },
    {
      kind: "RESULT_ROUTER",
      key: "review-result",
      sourceStepKey: "review-join",
      routes: { MAJOR_FINDING: "fix", CLEAN: "terminal" },
      fallbackTargetKey: "human-review",
    },
    { kind: "AGENT_RUN", key: "fix", runTemplateVersionId: "fix_v1", resultKeys: ["FIXED"] },
    { kind: "HUMAN_DECISION", key: "human-review", choices: ["APPROVE", "REJECT"] },
    { kind: "TERMINAL", key: "terminal", outcome: "COMPLETED" },
  ],
  transitions: [],
  maximumRunCount: 4,
  cycleBounds: { "fix->parallel-reviews": 1 },
  maximumParallelBranches: 2,
  maximumConcurrency: 2,
  absoluteDeadlineMs: 3_600_000,
};

export function BoundedAutomationJourney() {
  const [phase, setPhase] = useState<"DRAFT" | "PUBLISHED" | "BOUND" | "COMPLETED">("DRAFT");
  const completed = phase === "COMPLETED";
  const nodeStates = Object.fromEntries(
    JOURNEY_DEFINITION.nodes.map((node) => [
      node.key,
      { state: completed ? "COMPLETED" : "PENDING" },
    ]),
  );
  return (
    <section>
      <h1>Bounded Automation Journey</h1>
      <p>Strict local fixture. Provider-backed proof remains separate.</p>
      <div>
        <button type="button" disabled={phase !== "DRAFT"} onClick={() => setPhase("PUBLISHED")}>
          Publish version
        </button>
        <button type="button" disabled={phase !== "PUBLISHED"} onClick={() => setPhase("BOUND")}>
          Bind exact presets
        </button>
        <button type="button" disabled={phase !== "BOUND"} onClick={() => setPhase("COMPLETED")}>
          Start workflow
        </button>
      </div>
      <WorkflowExecutionView
        definition={JOURNEY_DEFINITION}
        execution={{
          name: "Implementation and independent review",
          state: completed ? "COMPLETED" : "ACTIVE",
          nodes: nodeStates,
        }}
      />
      <output data-testid="fix-run-count">{completed ? "1" : "0"}</output>
      <p>
        Live canonical proof: <strong data-testid="live-proof-status">BLOCKED</strong>
      </p>
    </section>
  );
}
