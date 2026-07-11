import { expect, test } from "bun:test";
import { performRevisionCas } from "../../../src/server/adapters/github/revision-cas.ts";
import { command, fixture, observedIssue } from "./mutation-fixture.ts";

test("read-compare-write reports the residual provider race", async () => {
  const f = fixture();
  const current = await observedIssue(f.github);
  const mutation = {
    kind: "EDIT_ISSUE" as const,
    issue: { kind: "ISSUE" as const, repositoryId: "101", number: 1 },
    title: "Updated",
  };
  const result = await performRevisionCas({
    current,
    command: command(mutation, {
      kind: "EXACT_REVISION",
      sourceRevision: current.sourceRevision,
      comparableDigest: current.comparableDigest,
    }),
    write: async () => ({ ok: true, value: current }),
  });
  expect(result).toMatchObject({ ok: true, value: { consistency: "RESIDUAL_RACE" } });
});
