import { expect, test } from "bun:test";
import { applyWorkflowRevocation } from "../../../src/server/modules/workflows/revocation.ts";

test("revocation invalidates affected future work and retains unaffected active work", () => {
  const calls: unknown[] = [];
  const event = { kind: "MEMBER", subjectId: "member_1", epoch: 2 } as const;
  applyWorkflowRevocation(
    {
      invalidateAffectedLaunchIntents: (value) => calls.push(["INVALIDATE", value]),
      moveRequiredAffectedWorkflowsToWaiting: (value, reason) =>
        calls.push(["WAIT", value, reason]),
      retainUnaffectedActiveWork: () => calls.push(["RETAIN"]),
    },
    event,
  );
  expect(calls).toEqual([
    ["INVALIDATE", event],
    ["WAIT", event, "WORKFLOW_AUTHORITY_REVOKED"],
    ["RETAIN"],
  ]);
});
