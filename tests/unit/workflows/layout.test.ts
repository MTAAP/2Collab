import { expect, test } from "bun:test";
import { semanticHash } from "../../../src/server/modules/workflows/definition.ts";
import { layoutHash } from "../../../src/server/modules/workflows/versioning.ts";
import { validDefinition, validLayout } from "../../fixtures/workflows/valid.ts";

test("layout changes do not change workflow semantics", () => {
  const semantic = semanticHash(validDefinition);
  const moved = {
    ...validLayout,
    nodes: validLayout.nodes.map((node) =>
      node.key === "implement" ? { ...node, x: 800, y: 120 } : node,
    ),
  };
  expect(semanticHash(validDefinition)).toBe(semantic);
  expect(layoutHash(moved)).not.toBe(layoutHash(validLayout));
});
