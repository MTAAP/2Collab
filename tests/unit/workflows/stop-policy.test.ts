import { describe, expect, test } from "bun:test";
import { evaluateStopPolicy } from "../../../src/server/modules/workflows/stop-policy.ts";
import type { StopPolicy } from "../../../src/shared/contracts/stop-policies.ts";

const source = {
  kind: "SOURCE",
  predicate: { kind: "GITHUB_CHECK", key: "ci" },
} as const satisfies StopPolicy;

describe("three-valued Stop Policies", () => {
  test("UNKNOWN neither increments nor resets consecutive matches", () => {
    const policy = {
      kind: "CONSECUTIVE_MATCHES",
      condition: source,
      count: 3,
    } as const satisfies StopPolicy;
    expect(evaluateStopPolicy(policy, { source: { ci: "UNKNOWN" } }, { matches: 2 })).toEqual({
      result: "UNKNOWN",
      state: { matches: 2 },
    });
  });

  test("FALSE resets and TRUE increments consecutive matches", () => {
    const policy = {
      kind: "CONSECUTIVE_MATCHES",
      condition: source,
      count: 2,
    } as const satisfies StopPolicy;
    expect(evaluateStopPolicy(policy, { source: { ci: "FALSE" } }, { matches: 1 })).toEqual({
      result: "FALSE",
      state: { matches: 0 },
    });
    expect(evaluateStopPolicy(policy, { source: { ci: "TRUE" } }, { matches: 1 })).toEqual({
      result: "TRUE",
      state: { matches: 2 },
    });
  });

  test("ALL ANY and NOT preserve UNKNOWN", () => {
    expect(
      evaluateStopPolicy(
        { kind: "ALL", conditions: [source, { kind: "NOT", condition: source }] },
        { source: { ci: "UNKNOWN" } },
        { matches: 0 },
      ).result,
    ).toBe("UNKNOWN");
  });
});
