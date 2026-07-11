import type { TeamRunTemplateVersion } from "../../../shared/contracts/templates.ts";
import type { WorkflowDefinition, WorkflowNode } from "../../../shared/contracts/workflow.ts";

export type WorkflowDiagnostic = Readonly<{ path: string; code: string; message: string }>;

const diagnostic = (path: string, code: string, message: string): WorkflowDiagnostic => ({
  path,
  code,
  message,
});

function cycleNodes(definition: WorkflowDefinition): Set<string> {
  const graph = new Map<string, string[]>();
  for (const transition of definition.transitions) {
    graph.set(transition.from, [...(graph.get(transition.from) ?? []), transition.to]);
  }
  const inCycle = new Set<string>();
  const visit = (start: string, current: string, seen: Set<string>): void => {
    for (const target of graph.get(current) ?? []) {
      if (target === start) inCycle.add(start);
      else if (!seen.has(target)) visit(start, target, new Set([...seen, target]));
    }
  };
  for (const key of graph.keys()) visit(key, key, new Set([key]));
  return inCycle;
}

export function validateWorkflow(
  definition: WorkflowDefinition,
  templates: ReadonlyMap<string, TeamRunTemplateVersion>,
): readonly WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const byKey = new Map<string, WorkflowNode>();
  for (const [index, node] of definition.nodes.entries()) {
    if (byKey.has(node.key))
      diagnostics.push(
        diagnostic(
          `nodes[${index}].key`,
          "WORKFLOW_NODE_KEY_DUPLICATE",
          "Node keys must be unique.",
        ),
      );
    byKey.set(node.key, node);
  }
  const starts = definition.nodes.filter((node) => node.kind === "START");
  if (starts.length !== 1)
    diagnostics.push(
      diagnostic("nodes", "WORKFLOW_START_REQUIRED", "Exactly one START node is required."),
    );
  if (!definition.nodes.some((node) => node.kind === "TERMINAL"))
    diagnostics.push(
      diagnostic("nodes", "WORKFLOW_TERMINAL_REQUIRED", "At least one TERMINAL node is required."),
    );
  if (
    definition.maximumRunCount < 1 ||
    definition.maximumConcurrency < 1 ||
    definition.maximumParallelBranches < 1 ||
    definition.absoluteDeadlineMs < 1
  )
    diagnostics.push(
      diagnostic("bounds", "WORKFLOW_BOUND_INVALID", "All workflow bounds must be positive."),
    );

  for (const [index, transition] of definition.transitions.entries()) {
    if (!byKey.has(transition.from) || !byKey.has(transition.to))
      diagnostics.push(
        diagnostic(
          `transitions[${index}]`,
          "WORKFLOW_TRANSITION_TARGET_INVALID",
          "Transitions must reference existing nodes.",
        ),
      );
  }

  const reachable = new Set<string>();
  const queue = starts.map((node) => node.key);
  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (reachable.has(key)) continue;
    reachable.add(key);
    for (const transition of definition.transitions)
      if (transition.from === key) queue.push(transition.to);
  }
  for (const [index, node] of definition.nodes.entries()) {
    if (!reachable.has(node.key))
      diagnostics.push(
        diagnostic(`nodes[${index}]`, "WORKFLOW_NODE_UNREACHABLE", "The node is unreachable."),
      );
    if (node.kind === "AGENT_RUN") {
      const template = templates.get(node.runTemplateVersionId);
      if (!template)
        diagnostics.push(
          diagnostic(
            `nodes[${index}].runTemplateVersionId`,
            "RUN_TEMPLATE_VERSION_STALE",
            "The referenced Run Template version is unavailable.",
          ),
        );
      else if (node.resultKeys.some((key) => !template.definition.resultKeys.includes(key)))
        diagnostics.push(
          diagnostic(
            `nodes[${index}].resultKeys`,
            "WORKFLOW_RESULT_INCOMPATIBLE",
            "The step result contract does not match its Run Template version.",
          ),
        );
    }
    if (node.kind === "JOIN") {
      if (node.policy === "ANY" && !node.remainderPolicy)
        diagnostics.push(
          diagnostic(
            `nodes[${index}].remainderPolicy`,
            "WORKFLOW_JOIN_INVALID",
            "ANY joins require a remainder policy.",
          ),
        );
      if (node.policy === "ALL" && node.remainderPolicy)
        diagnostics.push(
          diagnostic(
            `nodes[${index}].remainderPolicy`,
            "WORKFLOW_JOIN_INVALID",
            "ALL joins do not accept a remainder policy.",
          ),
        );
    }
    if (node.kind === "RESULT_ROUTER") {
      const source = byKey.get(node.sourceStepKey);
      if (source?.kind !== "AGENT_RUN")
        diagnostics.push(
          diagnostic(
            `nodes[${index}].sourceStepKey`,
            "WORKFLOW_RESULT_SOURCE_INVALID",
            "A Result Router must reference an Agent Run step.",
          ),
        );
      for (const [resultKey, targetKey] of Object.entries(node.routes)) {
        if (
          !definition.transitions.some(
            (transition) =>
              transition.from === node.key &&
              transition.resultKey === resultKey &&
              transition.to === targetKey,
          )
        )
          diagnostics.push(
            diagnostic(
              `nodes[${index}].routes.${resultKey}`,
              "WORKFLOW_RESULT_ROUTE_MISSING",
              "Every typed result route requires an exact transition.",
            ),
          );
      }
      if (
        !definition.transitions.some(
          (transition) =>
            transition.from === node.key &&
            transition.resultKey === "FALLBACK" &&
            transition.to === node.fallbackTargetKey,
        )
      )
        diagnostics.push(
          diagnostic(
            `nodes[${index}].fallbackTargetKey`,
            "WORKFLOW_RESULT_FALLBACK_REQUIRED",
            "Every Result Router requires an exact fallback transition.",
          ),
        );
    }
    if (node.kind === "PARALLEL_SPLIT") {
      if (
        node.branchKeys.length > definition.maximumParallelBranches ||
        node.branchKeys.some((key) => {
          const branch = byKey.get(key);
          return (
            branch?.kind !== "AGENT_RUN" ||
            templates.get(branch.runTemplateVersionId)?.definition.repositoryMode !== "INSPECT_ONLY"
          );
        })
      )
        diagnostics.push(
          diagnostic(
            `nodes[${index}].branchKeys`,
            "WORKFLOW_PARALLEL_MUTATION_FORBIDDEN",
            "Parallel branches must be bounded INSPECT_ONLY Agent Runs.",
          ),
        );
    }
  }

  const boundedCycles = Object.keys(definition.cycleBounds);
  for (const key of cycleNodes(definition)) {
    if (!boundedCycles.some((cycle) => cycle.split("->").includes(key)))
      diagnostics.push(
        diagnostic(
          "cycleBounds",
          "WORKFLOW_CYCLE_BOUND_REQUIRED",
          "Every workflow cycle requires a positive traversal bound.",
        ),
      );
  }
  return diagnostics;
}
