import { describe, expect, test } from "bun:test";
import {
  WorkflowDefinitionSchema,
  WORKFLOW_NODE_KINDS,
} from "../../../src/shared/contracts/workflow.ts";
import { semanticHash } from "../../../src/server/modules/workflows/definition.ts";
import { validDefinition } from "../../fixtures/workflows/valid.ts";

describe("canonical Workflow Definition", () => {
  test("has exactly the seven closed node kinds", () => {
    expect(WORKFLOW_NODE_KINDS).toEqual([
      "START",
      "AGENT_RUN",
      "HUMAN_DECISION",
      "RESULT_ROUTER",
      "PARALLEL_SPLIT",
      "JOIN",
      "TERMINAL",
    ]);
  });

  test("rejects React Flow presentation state", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({ ...validDefinition, reactFlowNodes: [] }),
    ).toThrow();
  });

  test("semantic changes change the semantic hash", () => {
    expect(semanticHash({ ...validDefinition, maximumRunCount: 6 })).not.toBe(
      semanticHash(validDefinition),
    );
  });
});
