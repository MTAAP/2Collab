import { describe, expect, test } from "bun:test";
import {
  aggregateOperationalUsage,
  aggregateUsage,
} from "../../../src/server/modules/telemetry/usage.ts";

describe("honest usage telemetry", () => {
  test("keeps unknown eligible attempts in coverage instead of inventing zero", () => {
    const groups = aggregateUsage(
      [
        { attemptId: "attempt_1", runtime: "CLAUDE", provider: "ANTHROPIC" },
        { attemptId: "attempt_2", runtime: "CLAUDE", provider: "ANTHROPIC" },
      ],
      [
        {
          observationId: "usage_1",
          attemptId: "attempt_1",
          runtime: "CLAUDE",
          provider: "ANTHROPIC",
          modelIdentifier: "claude-sonnet",
          category: "OUTPUT",
          units: 10,
          observedAt: 100,
        },
      ],
    );

    expect(groups).toEqual([
      {
        runtime: "CLAUDE",
        provider: "ANTHROPIC",
        modelIdentifier: "claude-sonnet",
        category: "OUTPUT",
        knownUnits: 10,
        knownAttempts: 1,
        totalAttempts: 2,
        coverage: "PARTIAL",
      },
    ]);
  });

  test("treats structured zero as known and separates incompatible dimensions", () => {
    const groups = aggregateUsage(
      [
        { attemptId: "attempt_1", runtime: "CODEX", provider: "OPENAI" },
        { attemptId: "attempt_2", runtime: "CODEX", provider: "OPENAI" },
      ],
      [
        {
          observationId: "usage_1",
          attemptId: "attempt_1",
          runtime: "CODEX",
          provider: "OPENAI",
          modelIdentifier: "gpt-5",
          category: "INPUT",
          units: 0,
          observedAt: 100,
        },
        {
          observationId: "usage_2",
          attemptId: "attempt_2",
          runtime: "CODEX",
          provider: "OPENAI",
          modelIdentifier: "gpt-5",
          category: "TOTAL",
          units: 20,
          observedAt: 100,
        },
      ],
    );

    expect(groups).toHaveLength(2);
    expect(groups).toContainEqual(
      expect.objectContaining({
        category: "INPUT",
        knownUnits: 0,
        knownAttempts: 1,
        totalAttempts: 2,
        coverage: "PARTIAL",
      }),
    );
    expect(groups).toContainEqual(expect.objectContaining({ category: "TOTAL", knownUnits: 20 }));
  });

  test("deduplicates observations and rejects mismatched attempt provenance", () => {
    const result = aggregateUsage(
      [{ attemptId: "attempt_1", runtime: "CODEX", provider: "OPENAI" }],
      [
        {
          observationId: "usage_1",
          attemptId: "attempt_1",
          runtime: "CODEX",
          provider: "OPENAI",
          modelIdentifier: "gpt-5",
          category: "OUTPUT",
          units: 2,
          observedAt: 100,
        },
        {
          observationId: "usage_1",
          attemptId: "attempt_1",
          runtime: "CODEX",
          provider: "OPENAI",
          modelIdentifier: "gpt-5",
          category: "OUTPUT",
          units: 2,
          observedAt: 100,
        },
        {
          observationId: "usage_2",
          attemptId: "attempt_missing",
          runtime: "CODEX",
          provider: "OPENAI",
          modelIdentifier: "gpt-5",
          category: "OUTPUT",
          units: 999,
          observedAt: 100,
        },
      ],
    );

    expect(result).toEqual([
      expect.objectContaining({ knownUnits: 2, knownAttempts: 1, totalAttempts: 1 }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/cost|currency|price/i);
  });

  test("scopes observation deduplication to attempt and metric category", () => {
    const result = aggregateUsage(
      [
        { attemptId: "attempt_1", runtime: "CODEX", provider: "OPENAI" },
        { attemptId: "attempt_2", runtime: "CODEX", provider: "OPENAI" },
        { attemptId: "attempt_2", runtime: "CODEX", provider: "OPENAI" },
      ],
      [
        {
          observationId: "structured_final",
          attemptId: "attempt_1",
          runtime: "CODEX",
          provider: "OPENAI",
          modelIdentifier: "gpt-5",
          category: "INPUT",
          units: 3,
          observedAt: 100,
        },
        {
          observationId: "structured_final",
          attemptId: "attempt_1",
          runtime: "CODEX",
          provider: "OPENAI",
          modelIdentifier: "gpt-5",
          category: "OUTPUT",
          units: 5,
          observedAt: 100,
        },
        {
          observationId: "structured_final",
          attemptId: "attempt_2",
          runtime: "CODEX",
          provider: "OPENAI",
          modelIdentifier: "gpt-5",
          category: "OUTPUT",
          units: 7,
          observedAt: 100,
        },
      ],
    );

    expect(result).toEqual([
      expect.objectContaining({ category: "INPUT", knownUnits: 3, totalAttempts: 2 }),
      expect.objectContaining({
        category: "OUTPUT",
        knownUnits: 12,
        knownAttempts: 2,
        totalAttempts: 2,
        coverage: "COMPLETE",
      }),
    ]);
  });

  test("does not put attempts with incompatible reported models in each other's denominator", () => {
    const groups = aggregateUsage(
      [
        { attemptId: "attempt_1", runtime: "CODEX", provider: "OPENAI" },
        { attemptId: "attempt_2", runtime: "CODEX", provider: "OPENAI" },
      ],
      [
        {
          observationId: "usage_1",
          attemptId: "attempt_1",
          runtime: "CODEX",
          provider: "OPENAI",
          modelIdentifier: "gpt-a",
          category: "OUTPUT",
          units: 1,
          observedAt: 100,
        },
        {
          observationId: "usage_2",
          attemptId: "attempt_2",
          runtime: "CODEX",
          provider: "OPENAI",
          modelIdentifier: "gpt-b",
          category: "OUTPUT",
          units: 2,
          observedAt: 100,
        },
      ],
    );
    expect(groups).toEqual([
      expect.objectContaining({ modelIdentifier: "gpt-a", totalAttempts: 1, coverage: "COMPLETE" }),
      expect.objectContaining({ modelIdentifier: "gpt-b", totalAttempts: 1, coverage: "COMPLETE" }),
    ]);
  });

  test("derives operational counts and reports incomplete durations as unknown coverage", () => {
    expect(
      aggregateOperationalUsage(
        [
          { attemptId: "attempt_1", startedAt: 10, terminalAt: 30 },
          { attemptId: "attempt_2", startedAt: 40 },
        ],
        [
          { attemptId: "attempt_1", cause: "INITIAL" },
          { attemptId: "attempt_2", cause: "MANAGED_LOOP", managedLoopIteration: 1 },
        ],
        [
          { gateEvaluationId: "gate_1", gateKey: "lint", durationMs: 5 },
          { gateEvaluationId: "gate_2", gateKey: "lint", durationMs: "UNKNOWN" },
        ],
      ),
    ).toEqual({
      attemptCount: 2,
      attemptCauses: {
        knownAttempts: 2,
        totalAttempts: 2,
        coverage: "COMPLETE",
      },
      managedLoopIterationCount: 1,
      wallClock: {
        knownMilliseconds: 20,
        knownAttempts: 1,
        totalAttempts: 2,
        coverage: "PARTIAL",
      },
      gates: [
        {
          gateKey: "lint",
          knownMilliseconds: 5,
          knownEvaluations: 1,
          totalEvaluations: 2,
          coverage: "PARTIAL",
        },
      ],
    });
  });
});
