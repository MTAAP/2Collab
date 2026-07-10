import { z } from "zod";
import type { ConnectorId, CoordinationRecordId, ProjectId } from "./ids.ts";
import { IdentifierSchema, RevisionSchema } from "./ids.ts";

export type SourceRef = Readonly<{
  kind: "GITHUB_ISSUE" | "GITHUB_PULL_REQUEST" | "OUTLINE_DOCUMENT";
  connectorId: ConnectorId;
  sourceItemId: string;
  observedRevision: string;
}>;

export type ContextReference = Readonly<{
  kind: "COORDINATION_RECORD" | "SOURCE" | "PUBLISHED_GIT_REFERENCE";
  projectId: ProjectId;
  referenceId: string;
  observedRevision?: string;
}>;

export type CoordinationSelection =
  | Readonly<{ kind: "NEW"; title: string; sourceRefs: readonly SourceRef[] }>
  | Readonly<{
      kind: "EXISTING";
      coordinationRecordId: CoordinationRecordId;
      expectedRevision: number;
    }>;

export const SourceRefSchema = z
  .object({
    kind: z.enum(["GITHUB_ISSUE", "GITHUB_PULL_REQUEST", "OUTLINE_DOCUMENT"]),
    connectorId: IdentifierSchema,
    sourceItemId: z.string().min(1).max(256),
    observedRevision: z.string().min(1).max(128),
  })
  .strict();

export const CoordinationSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("NEW"),
      title: z.string().min(1).max(160),
      sourceRefs: z.array(SourceRefSchema).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("EXISTING"),
      coordinationRecordId: IdentifierSchema,
      expectedRevision: RevisionSchema,
    })
    .strict(),
]);
