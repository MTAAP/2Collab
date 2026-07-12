import { z } from "zod";
import { IdentifierSchema, InstantSchema } from "./ids.ts";
import { RunViewSchema } from "./runs.ts";

export const PublicProjectionEventSchema = z
  .object({
    kind: z.literal("PROJECTION"),
    cursor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    committed: z.literal(true),
    projectId: IdentifierSchema,
    occurredAt: InstantSchema,
    data: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("RUN_CHANGED"), run: RunViewSchema }).strict(),
    ]),
  })
  .strict();

export const PublicProjectionResetSchema = z
  .object({
    kind: z.literal("RESET"),
    cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reason: z.enum(["CURSOR_STALE", "SLOW_CONSUMER", "STREAM_INVALID", "AUTHORITY_CHANGED"]),
  })
  .strict();

export const PublicProjectionMessageSchema = z.discriminatedUnion("kind", [
  PublicProjectionEventSchema,
  PublicProjectionResetSchema,
]);

export type PublicProjectionEvent = Readonly<z.infer<typeof PublicProjectionEventSchema>>;
export type PublicProjectionReset = Readonly<z.infer<typeof PublicProjectionResetSchema>>;
export type PublicProjectionMessage = Readonly<z.infer<typeof PublicProjectionMessageSchema>>;
