import { z } from "zod";
import type { Instant, ProjectId, TeamId } from "./ids.ts";
import { IdentifierSchema, InstantSchema, RevisionSchema } from "./ids.ts";

export type Project = Readonly<{
  id: ProjectId;
  teamId: TeamId;
  name: string;
  revision: number;
  createdAt: Instant;
}>;

export const ProjectSchema = z
  .object({
    id: IdentifierSchema,
    teamId: IdentifierSchema,
    name: z.string().min(1).max(120),
    revision: RevisionSchema,
    createdAt: InstantSchema,
  })
  .strict();

export const LocalProjectConfigSchema = z
  .object({
    project_id: IdentifierSchema,
    team_id: IdentifierSchema,
    server_url: z.url(),
    base_branch: z.string().min(1).max(255),
  })
  .strict();
