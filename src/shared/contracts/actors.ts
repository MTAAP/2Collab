import { z } from "zod";
import type { MemberId, RegisteredRunnerId, SessionId, WorkflowExecutionId } from "./ids.ts";
import { IdentifierSchema } from "./ids.ts";

export type MemberActor = Readonly<{
  kind: "MEMBER";
  memberId: MemberId;
  sessionId: SessionId;
}>;

export type SchedulerActor = Readonly<{
  kind: "SCHEDULER";
  originalDispatcherId: MemberId;
  workflowExecutionId?: WorkflowExecutionId;
}>;

export type RunnerActor = Readonly<{
  kind: "RUNNER";
  runnerId: RegisteredRunnerId;
  runnerEpoch: number;
}>;

export type AuthenticatedActor = MemberActor | SchedulerActor | RunnerActor;

export const AuthenticatedActorSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("MEMBER"), memberId: IdentifierSchema, sessionId: IdentifierSchema })
    .strict(),
  z
    .object({
      kind: z.literal("SCHEDULER"),
      originalDispatcherId: IdentifierSchema,
      workflowExecutionId: IdentifierSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("RUNNER"),
      runnerId: IdentifierSchema,
      runnerEpoch: z.number().int().nonnegative(),
    })
    .strict(),
]);
