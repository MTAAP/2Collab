import { createHash } from "node:crypto";
import type { InboxCategory } from "./inbox.ts";
export function githubInboxEvent(
  input: Readonly<{
    recipientMemberId: string;
    eventId: string;
    subjectKey: string;
    category: InboxCategory;
    safeSummary: string;
    sourceRevision?: string;
  }>,
) {
  const materialDigest = createHash("sha256")
    .update(
      JSON.stringify({
        category: input.category,
        subjectKey: input.subjectKey,
        safeSummary: input.safeSummary,
        sourceRevision: input.sourceRevision ?? null,
      }),
    )
    .digest("hex");
  return { ...input, eventType: input.category, materialDigest } as const;
}
