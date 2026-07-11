import { expect, test } from "bun:test";
import { noParkedProcessRequired } from "../../src/server/modules/workflows/human-decisions.ts";

test("WAITING human decisions require no active process", () => {
  expect(noParkedProcessRequired("WAITING", [])).toEqual({ ok: true, value: true });
  expect(noParkedProcessRequired("WAITING", ["attempt_1"])).toMatchObject({
    ok: false,
    error: { code: "WORKFLOW_PROCESS_STILL_ACTIVE" },
  });
});
