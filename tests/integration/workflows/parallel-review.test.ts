import { expect, test } from "bun:test";
import type { TeamRunTemplateVersion } from "../../../src/shared/contracts/templates.ts";
import type { WorkflowDefinition } from "../../../src/shared/contracts/workflow.ts";
import { prepareParallelGroup } from "../../../src/server/modules/workflows/parallel-groups.ts";

const template = (id: string, mode: "INSPECT_ONLY" | "MUTATING"): TeamRunTemplateVersion => ({
  id,
  templateKey: id,
  version: 1,
  semanticHash: "a".repeat(64),
  definition: {
    name: id,
    coreInstructions: "Review independently.",
    variables: [],
    resultKeys: ["CLEAN", "MAJOR_FINDING"],
    repositoryMode: mode,
    minimumAssurance: "ADVISORY",
    gateSets: [],
    maximumAttempts: 1,
    absoluteDeadlineMs: 1_000,
  },
});

test("parallel groups prepare only bounded INSPECT_ONLY branches", () => {
  const definition = {
    inputs: [],
    nodes: [
      { kind: "START", key: "start" },
      { kind: "PARALLEL_SPLIT", key: "split", branchKeys: ["claude", "codex"] },
      {
        kind: "AGENT_RUN",
        key: "claude",
        runTemplateVersionId: "claude_v1",
        resultKeys: ["CLEAN"],
      },
      { kind: "AGENT_RUN", key: "codex", runTemplateVersionId: "codex_v1", resultKeys: ["CLEAN"] },
      { kind: "TERMINAL", key: "done", outcome: "COMPLETED" },
    ],
    transitions: [],
    maximumRunCount: 2,
    cycleBounds: {},
    maximumParallelBranches: 2,
    maximumConcurrency: 2,
    absoluteDeadlineMs: 1_000,
  } as const satisfies WorkflowDefinition;
  const templates = new Map([
    ["claude_v1", template("claude_v1", "INSPECT_ONLY")],
    ["codex_v1", template("codex_v1", "INSPECT_ONLY")],
  ]);
  expect(prepareParallelGroup(definition, "split", templates)).toEqual(["claude", "codex"]);
  templates.set("codex_v1", template("codex_v1", "MUTATING"));
  expect(() => prepareParallelGroup(definition, "split", templates)).toThrow(
    "WORKFLOW_PARALLEL_MUTATION_FORBIDDEN",
  );
});
