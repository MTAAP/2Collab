import { z } from "zod";

export const RetryDispositionSchema = z.enum(["NEVER", "REFRESH", "EXPLICIT_RESUME", "SAME_INPUT"]);

const SafeDetailKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const SafeDetailSchema = z.union([z.string().max(128), z.number().finite(), z.boolean()]);
const SafeDetailsSchema = z
  .record(SafeDetailKeySchema, SafeDetailSchema)
  .refine((details) => Object.keys(details).length <= 16, "At most 16 safe details are allowed");

export const DomainErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    message: z.string().min(1).max(240),
    retry: RetryDispositionSchema,
    details: SafeDetailsSchema.optional(),
  })
  .strict();

export type DomainError = Readonly<z.infer<typeof DomainErrorSchema>>;

export type Result<T> =
  | Readonly<{ ok: true; value: T; auditId?: string }>
  | Readonly<{ ok: false; error: DomainError; auditId?: string }>;

export const ResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown(), auditId: z.string().optional() }).strict(),
  z
    .object({ ok: z.literal(false), error: DomainErrorSchema, auditId: z.string().optional() })
    .strict(),
]);
