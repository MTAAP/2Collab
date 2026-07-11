import { z } from "zod";

const OfflineDecisionInputSchema = z
  .object({
    connectedAndRenewed: z.boolean(),
    mode: z.enum(["INSPECT_ONLY", "MUTATING"]),
    now: z.number().int().nonnegative(),
    attemptDeadline: z.number().int().positive(),
    authoritySessionExpiresAt: z.number().int().positive(),
    mutationLeaseExpiresAt: z.number().int().positive().optional(),
    disconnectedAt: z.number().int().nonnegative(),
    disconnectGraceSeconds: z.number().int().positive().max(300),
  })
  .strict();

export type OfflineDecisionInput = Readonly<z.infer<typeof OfflineDecisionInputSchema>>;
export type OfflineDecision =
  | Readonly<{ action: "CONTINUE" }>
  | Readonly<{ action: "CONTINUE_INSPECTION" }>
  | Readonly<{ action: "CONTINUE_MUTATION_WITH_EXISTING_LEASE" }>
  | Readonly<{
      action: "CHECKPOINT_AND_STOP";
      code:
        | "ATTEMPT_DEADLINE_EXPIRED"
        | "AUTHORITY_SESSION_EXPIRED"
        | "MUTATION_LEASE_MISSING"
        | "MUTATION_LEASE_EXPIRED";
    }>;

export function decideOffline(candidate: OfflineDecisionInput): OfflineDecision {
  const input = OfflineDecisionInputSchema.parse(candidate);
  if (input.now >= input.attemptDeadline) {
    return { action: "CHECKPOINT_AND_STOP", code: "ATTEMPT_DEADLINE_EXPIRED" };
  }
  if (input.connectedAndRenewed) return { action: "CONTINUE" };
  if (input.mode === "INSPECT_ONLY") return { action: "CONTINUE_INSPECTION" };
  if (input.now >= input.authoritySessionExpiresAt) {
    return { action: "CHECKPOINT_AND_STOP", code: "AUTHORITY_SESSION_EXPIRED" };
  }
  if (input.mutationLeaseExpiresAt === undefined) {
    return { action: "CHECKPOINT_AND_STOP", code: "MUTATION_LEASE_MISSING" };
  }
  const mutationEnd = Math.min(
    input.mutationLeaseExpiresAt,
    input.disconnectedAt + input.disconnectGraceSeconds,
  );
  return input.now >= mutationEnd
    ? { action: "CHECKPOINT_AND_STOP", code: "MUTATION_LEASE_EXPIRED" }
    : { action: "CONTINUE_MUTATION_WITH_EXISTING_LEASE" };
}
