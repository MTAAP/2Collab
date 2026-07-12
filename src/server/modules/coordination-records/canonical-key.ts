import { z } from "zod";
import { IdentifierSchema } from "../../../shared/contracts/ids.ts";

const CanonicalSourceIdentitySchema = z
  .object({
    projectId: IdentifierSchema,
    connectorId: IdentifierSchema,
    sourceItemId: z.string().min(1).max(256),
  })
  .strict();

export function canonicalSourceReferenceKey(
  projectId: string,
  connectorId: string,
  sourceItemId: string,
): string {
  const parsed = CanonicalSourceIdentitySchema.safeParse({ projectId, connectorId, sourceItemId });
  if (!parsed.success) throw new Error("COORDINATION_SOURCE_INVALID");
  return [parsed.data.projectId, parsed.data.connectorId, parsed.data.sourceItemId]
    .map((value) => `${value.length}:${value}`)
    .join("|");
}
