import type { TeamRunTemplateVersion } from "../../../shared/contracts/templates.ts";
import type { WorkflowDefinition, WorkflowNode } from "../../../shared/contracts/workflow.ts";

export type WorkflowDiagnostic = Readonly<{ path: string; code: string; message: string }>;

const diagnostic = (path: string, code: string, message: string): WorkflowDiagnostic => ({
  path,
  code,
  message,
});

const sameKeys = (left: readonly string[], right: readonly string[]): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((key) => rightSet.has(key))
  );
};

const pairKey = (from: string, resultKey: string): string => `${from}\u0000${resultKey}`;
const edgeKey = (from: string, resultKey: string, to: string): string =>
  `${from}\u0000${resultKey}\u0000${to}`;

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
    else byKey.set(node.key, node);
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

  const seenEdges = new Set<string>();
  const targetByPair = new Map<string, string>();
  const outgoing = new Map<string, typeof definition.transitions>();
  for (const [index, transition] of definition.transitions.entries()) {
    const path = `transitions[${index}]`;
    if (!byKey.has(transition.from) || !byKey.has(transition.to))
      diagnostics.push(
        diagnostic(
          path,
          "WORKFLOW_TRANSITION_TARGET_INVALID",
          "Transitions must reference existing nodes.",
        ),
      );
    const identity = edgeKey(transition.from, transition.resultKey, transition.to);
    if (seenEdges.has(identity))
      diagnostics.push(
        diagnostic(path, "WORKFLOW_TRANSITION_DUPLICATE", "Duplicate transitions are forbidden."),
      );
    else seenEdges.add(identity);
    const pair = pairKey(transition.from, transition.resultKey);
    const priorTarget = targetByPair.get(pair);
    if (priorTarget !== undefined && priorTarget !== transition.to)
      diagnostics.push(
        diagnostic(
          path,
          "WORKFLOW_TRANSITION_AMBIGUOUS",
          "A typed output must select exactly one target.",
        ),
      );
    else targetByPair.set(pair, transition.to);
    outgoing.set(transition.from, [...(outgoing.get(transition.from) ?? []), transition]);
  }

  const exactTransition = (from: string, resultKey: string, to?: string): boolean => {
    const edges = (outgoing.get(from) ?? []).filter(
      (edge) => edge.resultKey === resultKey && (to === undefined || edge.to === to),
    );
    return edges.length === 1;
  };

  const joins = definition.nodes.filter((node) => node.kind === "JOIN");
  const splits = definition.nodes.filter((node) => node.kind === "PARALLEL_SPLIT");
  const joinsByBranch = new Map<string, typeof joins>();
  for (const join of joins)
    for (const branchKey of join.branchKeys)
      joinsByBranch.set(branchKey, [...(joinsByBranch.get(branchKey) ?? []), join]);

  for (const [index, node] of definition.nodes.entries()) {
    const nodeEdges = outgoing.get(node.key) ?? [];
    if (node.kind === "START") {
      if (!exactTransition(node.key, "STARTED"))
        diagnostics.push(
          diagnostic(
            `nodes[${index}]`,
            "WORKFLOW_START_TRANSITION_REQUIRED",
            "START requires exactly one STARTED transition.",
          ),
        );
      if (nodeEdges.some((edge) => edge.resultKey !== "STARTED"))
        diagnostics.push(
          diagnostic(
            `nodes[${index}]`,
            "WORKFLOW_TRANSITION_INCOMPATIBLE",
            "START only exposes the STARTED result.",
          ),
        );
    }
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
      else if (!sameKeys(node.resultKeys, template.definition.resultKeys))
        diagnostics.push(
          diagnostic(
            `nodes[${index}].resultKeys`,
            "WORKFLOW_RESULT_INCOMPATIBLE",
            "The step result contract does not match its Run Template version.",
          ),
        );
      if (!joinsByBranch.has(node.key)) {
        for (const resultKey of node.resultKeys)
          if (!exactTransition(node.key, resultKey))
            diagnostics.push(
              diagnostic(
                `nodes[${index}].resultKeys`,
                "WORKFLOW_RESULT_TRANSITION_REQUIRED",
                "Every Agent Run result requires exactly one typed transition.",
              ),
            );
      }
      const allowed = new Set([...node.resultKeys, "RUN_FAILED", "RUN_CANCELLED"]);
      if (nodeEdges.some((edge) => !allowed.has(edge.resultKey)))
        diagnostics.push(
          diagnostic(
            `nodes[${index}]`,
            "WORKFLOW_TRANSITION_INCOMPATIBLE",
            "Agent Run transitions must use declared or canonical system results.",
          ),
        );
    }
    if (node.kind === "HUMAN_DECISION") {
      for (const choice of node.choices)
        if (!exactTransition(node.key, choice))
          diagnostics.push(
            diagnostic(
              `nodes[${index}].choices`,
              "WORKFLOW_DECISION_TRANSITION_REQUIRED",
              "Every human choice requires exactly one typed transition.",
            ),
          );
      if (nodeEdges.some((edge) => !node.choices.includes(edge.resultKey)))
        diagnostics.push(
          diagnostic(
            `nodes[${index}]`,
            "WORKFLOW_TRANSITION_INCOMPATIBLE",
            "Human Decision transitions must use declared choices.",
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
      else {
        const routeKeys = Object.keys(node.routes);
        for (const resultKey of source.resultKeys)
          if (!(resultKey in node.routes))
            diagnostics.push(
              diagnostic(
                `nodes[${index}].routes`,
                "WORKFLOW_RESULT_ROUTE_REQUIRED",
                "Every source result requires a typed route.",
              ),
            );
        if (routeKeys.some((key) => !source.resultKeys.includes(key)))
          diagnostics.push(
            diagnostic(
              `nodes[${index}].routes`,
              "WORKFLOW_RESULT_INCOMPATIBLE",
              "Result Router routes must match the source result contract.",
            ),
          );
      }
      for (const [resultKey, targetKey] of Object.entries(node.routes))
        if (!exactTransition(node.key, resultKey, targetKey))
          diagnostics.push(
            diagnostic(
              `nodes[${index}].routes.${resultKey}`,
              "WORKFLOW_RESULT_ROUTE_MISSING",
              "Every typed result route requires an exact transition.",
            ),
          );
      if (!exactTransition(node.key, "FALLBACK", node.fallbackTargetKey))
        diagnostics.push(
          diagnostic(
            `nodes[${index}].fallbackTargetKey`,
            "WORKFLOW_RESULT_FALLBACK_REQUIRED",
            "Every Result Router requires an exact fallback transition.",
          ),
        );
      const allowed = new Set([...Object.keys(node.routes), "FALLBACK"]);
      if (nodeEdges.some((edge) => !allowed.has(edge.resultKey)))
        diagnostics.push(
          diagnostic(
            `nodes[${index}]`,
            "WORKFLOW_TRANSITION_INCOMPATIBLE",
            "Result Router transitions must use declared routes or FALLBACK.",
          ),
        );
    }
    if (node.kind === "PARALLEL_SPLIT") {
      const matchingJoins = joins.filter((join) => sameKeys(join.branchKeys, node.branchKeys));
      if (matchingJoins.length !== 1)
        diagnostics.push(
          diagnostic(
            `nodes[${index}].branchKeys`,
            "WORKFLOW_PARALLEL_JOIN_REQUIRED",
            "A parallel group requires exactly one join over the same branches.",
          ),
        );
      if (
        new Set(node.branchKeys).size !== node.branchKeys.length ||
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
            "Parallel branches must be unique, bounded INSPECT_ONLY Agent Runs.",
          ),
        );
      if (nodeEdges.length > 0)
        diagnostics.push(
          diagnostic(
            `nodes[${index}]`,
            "WORKFLOW_TRANSITION_INCOMPATIBLE",
            "Parallel Split branches are declared by branchKeys, not transitions.",
          ),
        );
    }
    if (node.kind === "JOIN") {
      if (splits.filter((split) => sameKeys(split.branchKeys, node.branchKeys)).length !== 1)
        diagnostics.push(
          diagnostic(
            `nodes[${index}].branchKeys`,
            "WORKFLOW_JOIN_BRANCHES_INVALID",
            "A join must match exactly one parallel group.",
          ),
        );
      const resultKeys = new Set(
        node.branchKeys.flatMap((key) => {
          const branch = byKey.get(key);
          return branch?.kind === "AGENT_RUN" ? [...branch.resultKeys] : [];
        }),
      );
      resultKeys.add("RUN_FAILED");
      resultKeys.add("RUN_CANCELLED");
      if (
        new Set(node.branchKeys).size !== node.branchKeys.length ||
        new Set(node.acceptedResultKeys).size !== node.acceptedResultKeys.length ||
        node.acceptedResultKeys.some((key) => !resultKeys.has(key))
      )
        diagnostics.push(
          diagnostic(
            `nodes[${index}]`,
            "WORKFLOW_JOIN_INVALID",
            "Join branches and accepted results must be unique and contract-compatible.",
          ),
        );
      if (node.policy === "ANY") {
        if (!node.remainderPolicy)
          diagnostics.push(
            diagnostic(
              `nodes[${index}].remainderPolicy`,
              "WORKFLOW_JOIN_INVALID",
              "ANY joins require a remainder policy.",
            ),
          );
        for (const key of node.acceptedResultKeys)
          if (!exactTransition(node.key, key))
            diagnostics.push(
              diagnostic(
                `nodes[${index}].acceptedResultKeys`,
                "WORKFLOW_JOIN_RESULT_TRANSITION_REQUIRED",
                "Every accepted ANY result requires exactly one typed transition.",
              ),
            );
        if (!exactTransition(node.key, "FALLBACK", node.fallbackTargetKey))
          diagnostics.push(
            diagnostic(
              `nodes[${index}].fallbackTargetKey`,
              "WORKFLOW_JOIN_FALLBACK_REQUIRED",
              "ANY joins require an exact FALLBACK transition.",
            ),
          );
        const allowed = new Set([...node.acceptedResultKeys, "FALLBACK"]);
        if (nodeEdges.some((edge) => !allowed.has(edge.resultKey)))
          diagnostics.push(
            diagnostic(
              `nodes[${index}]`,
              "WORKFLOW_TRANSITION_INCOMPATIBLE",
              "ANY join transitions must use accepted results or FALLBACK.",
            ),
          );
      } else {
        if (node.remainderPolicy)
          diagnostics.push(
            diagnostic(
              `nodes[${index}].remainderPolicy`,
              "WORKFLOW_JOIN_INVALID",
              "ALL joins do not accept a remainder policy.",
            ),
          );
        if (!exactTransition(node.key, "ALL"))
          diagnostics.push(
            diagnostic(
              `nodes[${index}]`,
              "WORKFLOW_JOIN_ALL_TRANSITION_REQUIRED",
              "ALL joins require exactly one ALL transition.",
            ),
          );
        if (nodeEdges.some((edge) => edge.resultKey !== "ALL"))
          diagnostics.push(
            diagnostic(
              `nodes[${index}]`,
              "WORKFLOW_TRANSITION_INCOMPATIBLE",
              "ALL joins expose only the ALL result.",
            ),
          );
      }
    }
    if (node.kind === "TERMINAL" && nodeEdges.length > 0)
      diagnostics.push(
        diagnostic(
          `nodes[${index}]`,
          "WORKFLOW_TRANSITION_INCOMPATIBLE",
          "Terminal nodes cannot have outgoing transitions.",
        ),
      );
  }

  // Execution has two implicit graph relations: a split launches each branch, and
  // a terminal branch result is serialized by its matching join.
  const graph = new Map<string, Set<string>>();
  const addGraphEdge = (from: string, to: string): void => {
    graph.set(from, new Set([...(graph.get(from) ?? []), to]));
  };
  for (const transition of definition.transitions)
    if (byKey.has(transition.from) && byKey.has(transition.to))
      addGraphEdge(transition.from, transition.to);
  for (const split of splits)
    for (const branch of split.branchKeys) addGraphEdge(split.key, branch);
  for (const join of joins) for (const branch of join.branchKeys) addGraphEdge(branch, join.key);

  const reachable = new Set<string>();
  const queue = starts.map((node) => node.key);
  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (reachable.has(key)) continue;
    reachable.add(key);
    queue.push(...(graph.get(key) ?? []));
  }
  for (const [index, node] of definition.nodes.entries())
    if (!reachable.has(node.key))
      diagnostics.push(
        diagnostic(`nodes[${index}]`, "WORKFLOW_NODE_UNREACHABLE", "The node is unreachable."),
      );

  const canReachTerminal = new Set(
    definition.nodes.filter((node) => node.kind === "TERMINAL").map((node) => node.key),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, targets] of graph)
      if (
        !canReachTerminal.has(from) &&
        [...targets].some((target) => canReachTerminal.has(target))
      ) {
        canReachTerminal.add(from);
        changed = true;
      }
  }
  for (const [index, node] of definition.nodes.entries())
    if (reachable.has(node.key) && !canReachTerminal.has(node.key))
      diagnostics.push(
        diagnostic(
          `nodes[${index}]`,
          "WORKFLOW_TERMINAL_PATH_REQUIRED",
          "Every reachable node must have a path to a terminal outcome.",
        ),
      );

  const declaredCycleEdges = new Set<string>();
  for (const [signature, bound] of Object.entries(definition.cycleBounds)) {
    const keys = signature.split("->");
    const cycleEdges = keys.map(
      (key, index) => [key, keys[(index + 1) % keys.length] ?? key] as const,
    );
    if (
      !Number.isInteger(bound) ||
      bound < 1 ||
      new Set(keys).size !== keys.length ||
      cycleEdges.some(([from, to]) => !graph.get(from)?.has(to))
    )
      diagnostics.push(
        diagnostic(
          `cycleBounds.${signature}`,
          "WORKFLOW_CYCLE_BOUND_INVALID",
          "Cycle bounds must name a real closed cycle and have a positive integer limit.",
        ),
      );
    else for (const [from, to] of cycleEdges) declaredCycleEdges.add(`${from}\u0000${to}`);
  }

  const pathExists = (start: string, target: string): boolean => {
    const seen = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const key = pending.pop() as string;
      if (key === target) return true;
      if (seen.has(key)) continue;
      seen.add(key);
      pending.push(...(graph.get(key) ?? []));
    }
    return false;
  };
  for (const [from, targets] of graph)
    for (const to of targets)
      if (pathExists(to, from) && !declaredCycleEdges.has(`${from}\u0000${to}`))
        diagnostics.push(
          diagnostic(
            "cycleBounds",
            "WORKFLOW_CYCLE_BOUND_REQUIRED",
            "Every workflow cycle edge requires a positive traversal bound.",
          ),
        );

  return diagnostics;
}
