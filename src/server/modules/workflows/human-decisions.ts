import type { Result } from "../../../shared/contracts/result.ts";
import type { WorkflowExecutionState } from "./contract.ts";

export function noParkedProcessRequired(
  state: WorkflowExecutionState,
  activeAttemptIds: readonly string[],
): Result<boolean> {
  if (state === "WAITING" && activeAttemptIds.length > 0)
    return {
      ok: false,
      error: {
        code: "WORKFLOW_PROCESS_STILL_ACTIVE",
        message: "A waiting workflow cannot retain an active process.",
        retry: "REFRESH",
      },
    };
  return { ok: true, value: state === "WAITING" };
}
