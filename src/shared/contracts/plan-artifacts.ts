import { z } from "zod";

export type PlanArtifact = Readonly<{
  approach: string;
  assumptions: readonly string[];
  risks: readonly string[];
  affectedAreas: readonly string[];
  verificationStrategy: readonly string[];
  evidence: readonly Readonly<{
    kind: "REFERENCE" | "AUTHORED_EXCERPT";
    reference: string;
    revision?: string;
  }>[];
}>;

export const PlanArtifactSchema: z.ZodType<PlanArtifact> = z
  .object({
    approach: z.string().min(1).max(4_000),
    assumptions: z.array(z.string().min(1).max(500)).max(32),
    risks: z.array(z.string().min(1).max(500)).max(32),
    affectedAreas: z.array(z.string().min(1).max(300)).max(64),
    verificationStrategy: z.array(z.string().min(1).max(500)).max(32),
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(["REFERENCE", "AUTHORED_EXCERPT"]),
            reference: z.string().min(1).max(1_000),
            revision: z.string().min(1).max(200).optional(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
