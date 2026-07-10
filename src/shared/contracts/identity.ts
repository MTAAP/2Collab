import { z } from "zod";
import type { Instant, MemberId, SessionId } from "./ids.ts";
import { IdentifierSchema, InstantSchema, RevisionSchema } from "./ids.ts";

export type TeamRole = "OWNER" | "MEMBER";
export type MemberStatus = "ACTIVE" | "REVOKED";

export type Member = Readonly<{
  id: MemberId;
  role: TeamRole;
  status: MemberStatus;
  authorityEpoch: number;
  revision: number;
}>;

export type MemberSession = Readonly<{
  id: SessionId;
  memberId: MemberId;
  expiresAt: Instant;
}>;

export const MemberSchema = z
  .object({
    id: IdentifierSchema,
    role: z.enum(["OWNER", "MEMBER"]),
    status: z.enum(["ACTIVE", "REVOKED"]),
    authorityEpoch: z.number().int().nonnegative(),
    revision: RevisionSchema,
  })
  .strict();

export const MemberSessionSchema = z
  .object({ id: IdentifierSchema, memberId: IdentifierSchema, expiresAt: InstantSchema })
  .strict();
