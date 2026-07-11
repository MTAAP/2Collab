import { z } from "zod";
import type { MemberId, RegisteredRunnerId, SessionId, WorkflowExecutionId } from "./ids.ts";
import { IdentifierSchema } from "./ids.ts";

declare const verifiedDevice: unique symbol;
declare const verifiedRunner: unique symbol;

export type MemberActor = Readonly<{
  kind: "MEMBER";
  memberId: MemberId;
  sessionId: SessionId;
  sessionProof: string;
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

export type VerifiedDevicePrincipal = Readonly<{
  kind: "VERIFIED_DEVICE";
  memberId: MemberId;
  memberAuthorityEpoch: number;
  deviceFamilyId: string;
  deviceId: string;
  senderKeyThumbprint: string;
  readonly [verifiedDevice]: true;
}>;

export type VerifiedRunnerPrincipal = Readonly<{
  kind: "VERIFIED_RUNNER";
  runnerId: RegisteredRunnerId;
  runnerEpoch: number;
  ownerMemberId: MemberId;
  keyThumbprint: string;
  accessExpiresAt: number;
  readonly [verifiedRunner]: true;
}>;

export type AuthenticatedActor = MemberActor | SchedulerActor | RunnerActor;

export const MemberActorSchema = z
  .object({
    kind: z.literal("MEMBER"),
    memberId: IdentifierSchema,
    sessionId: IdentifierSchema,
    sessionProof: z.string().min(32).max(512),
  })
  .strict();
export const SchedulerActorSchema = z
  .object({
    kind: z.literal("SCHEDULER"),
    originalDispatcherId: IdentifierSchema,
    workflowExecutionId: IdentifierSchema.optional(),
  })
  .strict();
export const RunnerActorSchema = z
  .object({
    kind: z.literal("RUNNER"),
    runnerId: IdentifierSchema,
    runnerEpoch: z.number().int().nonnegative(),
  })
  .strict();

export const AuthenticatedActorSchema = z.discriminatedUnion("kind", [
  MemberActorSchema,
  SchedulerActorSchema,
  RunnerActorSchema,
]);
