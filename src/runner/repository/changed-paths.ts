import { z } from "zod";
import { CommitShaSchema, IdentifierSchema, InstantSchema } from "../../shared/contracts/ids.ts";
import { RepositoryRelativePathSchema } from "../../shared/contracts/runners.ts";

export const ChangedPathSnapshotSchema = z
  .object({
    runId: IdentifierSchema,
    baseCommit: CommitShaSchema,
    headCommit: CommitShaSchema,
    observedAt: InstantSchema,
    paths: z.array(RepositoryRelativePathSchema).max(2_048),
    truncated: z.boolean(),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(value.paths.join("\n")).length <= 262_144,
    "Changed paths exceed byte bound",
  );
export type ChangedPathSnapshot = Readonly<z.infer<typeof ChangedPathSnapshotSchema>>;

export function createChangedPathSnapshot(
  input: Readonly<{
    runId: string;
    baseCommit: string;
    headCommit: string;
    observedAt: number;
    paths: readonly string[];
  }>,
): ChangedPathSnapshot {
  const accepted: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const path of input.paths) {
    const parsed = RepositoryRelativePathSchema.safeParse(path);
    if (!parsed.success) throw new Error("CHANGED_PATH_INVALID");
    const size = new TextEncoder().encode(`${parsed.data}\n`).length;
    if (accepted.length >= 2_048 || bytes + size > 262_144) {
      truncated = true;
      break;
    }
    accepted.push(parsed.data);
    bytes += size;
  }
  return ChangedPathSnapshotSchema.parse({ ...input, paths: accepted, truncated });
}
