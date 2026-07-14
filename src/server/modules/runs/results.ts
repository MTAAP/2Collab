import { z } from "zod";
import type { Result } from "../../../shared/contracts/result.ts";
import type { AgentRunState } from "../../../shared/contracts/runs.ts";

const ResultInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["DELIVERED", "NO_CHANGES"]),
      summary: z.string().min(1).max(2_048),
      evidenceIds: z.array(z.string().min(1).max(128)).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["BLOCKED", "ESCALATED"]),
      summary: z.string().min(1).max(2_048),
      reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
      requestedAction: z.enum(["RESPOND", "RESUME", "SELECT_RUNNER", "ADOPT_FOLLOW_UP", "NONE"]),
      evidenceIds: z.array(z.string().min(1).max(128)).max(128),
    })
    .strict(),
]);

export type RunResultInput = z.infer<typeof ResultInputSchema>;

export function evaluateRunResult(
  input: RunResultInput,
): Result<Readonly<{ state: AgentRunState; waitingReason?: "BLOCKED" | "HUMAN_INPUT" }>> {
  const parsed = ResultInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "RESULT_CONTRACT_VIOLATION",
        message: "Run Result does not satisfy its typed contract.",
        retry: "NEVER",
      },
    };
  }
  if (parsed.data.kind === "BLOCKED") {
    return { ok: true, value: { state: "WAITING", waitingReason: "BLOCKED" } };
  }
  if (parsed.data.kind === "ESCALATED") {
    return { ok: true, value: { state: "WAITING", waitingReason: "HUMAN_INPUT" } };
  }
  return { ok: true, value: { state: "RUNNING" } };
}
