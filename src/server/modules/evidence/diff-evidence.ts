import { z } from "zod";
import { CommitShaSchema, InstantSchema } from "../../../shared/contracts/ids.ts";
import { RepositoryRelativePathSchema } from "../../../shared/contracts/runners.ts";

export const DiffEvidenceSchema = z
  .object({
    baseCommit: CommitShaSchema,
    headCommit: CommitShaSchema,
    observedAt: InstantSchema,
    filesChanged: z.number().int().nonnegative().max(100_000),
    additions: z.number().int().nonnegative().max(10_000_000),
    deletions: z.number().int().nonnegative().max(10_000_000),
    paths: z.array(RepositoryRelativePathSchema).max(2_048),
    truncated: z.boolean(),
    verificationEvidenceIds: z.array(z.string().min(1).max(128)).max(128),
  })
  .strict();
export type DiffEvidence = Readonly<z.infer<typeof DiffEvidenceSchema>>;

export function requireDeliverableDiffEvidence(input: unknown) {
  const parsed = DiffEvidenceSchema.safeParse(input);
  return parsed.success
    ? { ok: true as const, value: parsed.data }
    : {
        ok: false as const,
        error: {
          code: "DIFF_EVIDENCE_REQUIRED",
          message: "Bounded diff evidence is required.",
          retry: "REFRESH" as const,
        },
      };
}
