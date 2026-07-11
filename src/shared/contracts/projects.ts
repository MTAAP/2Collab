import { z } from "zod";
import type { MemberActor } from "./actors.ts";
import { MemberActorSchema } from "./actors.ts";
import type { Instant, ProjectId, TeamId } from "./ids.ts";
import { IdentifierSchema, InstantSchema, RevisionSchema } from "./ids.ts";
import type { GitRefSchema } from "./runners.ts";
import { GitRefSchema as GitRefRuntimeSchema } from "./runners.ts";

export type GitRef = z.infer<typeof GitRefSchema>;

export const CanonicalServerOriginSchema = z
  .string()
  .min(1)
  .max(2_048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid server origin" });
      return z.NEVER;
    }
    const localhost = url.hostname === "localhost";
    if (
      !url.hostname ||
      url.username !== "" ||
      url.password !== "" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && localhost))
    ) {
      context.addIssue({ code: "custom", message: "Invalid server origin" });
      return z.NEVER;
    }
    return url.origin;
  });

export type Project = Readonly<{
  id: ProjectId;
  teamId: TeamId;
  name: string;
  baseBranch: GitRef;
  revision: number;
  createdAt: Instant;
}>;

export const ProjectSchema = z
  .object({
    id: IdentifierSchema,
    teamId: IdentifierSchema,
    name: z.string().min(1).max(120),
    baseBranch: GitRefRuntimeSchema,
    revision: RevisionSchema,
    createdAt: InstantSchema,
  })
  .strict();

export const ProjectViewSchema = ProjectSchema;
export type ProjectView = Project;

export const ProjectConfigSchema = z
  .object({
    project_id: IdentifierSchema,
    team_id: IdentifierSchema,
    server_url: CanonicalServerOriginSchema,
    base_branch: GitRefRuntimeSchema,
  })
  .strict();

export const LocalProjectConfigSchema = ProjectConfigSchema;

export const CreateProjectSchema = z
  .object({
    actor: MemberActorSchema,
    name: z.string().trim().min(1).max(120),
    baseBranch: GitRefRuntimeSchema,
  })
  .strict();

export const InspectProjectSchema = z
  .object({
    actor: MemberActorSchema,
    projectId: IdentifierSchema,
  })
  .strict();

export const ListProjectsSchema = z.object({ actor: MemberActorSchema }).strict();

export type CreateProject = Readonly<{
  actor: MemberActor;
  name: string;
  baseBranch: GitRef;
}>;
export type InspectProject = Readonly<{ actor: MemberActor; projectId: ProjectId }>;
export type ListProjects = Readonly<{ actor: MemberActor }>;
