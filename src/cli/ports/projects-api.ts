import type { Result } from "../../shared/contracts/result.ts";
import { z } from "zod";
import type { ProjectId } from "../../shared/contracts/ids.ts";
import { IdentifierSchema } from "../../shared/contracts/ids.ts";
import { CanonicalServerOriginSchema, type ProjectView } from "../../shared/contracts/projects.ts";

const ExactServerOriginSchema = z.string().refine((value) => {
  const origin = CanonicalServerOriginSchema.safeParse(value);
  return origin.success && origin.data === value;
}, "Server origin must be canonical");

export type ProjectIdentityRequest = Readonly<{
  serverOrigin: string;
  projectId: ProjectId;
}>;

export const ProjectIdentityRequestSchema = z
  .object({
    serverOrigin: ExactServerOriginSchema,
    projectId: IdentifierSchema,
  })
  .strict();

export const ProjectListRequestSchema = z
  .object({ serverOrigin: ExactServerOriginSchema })
  .strict();

export interface ProjectsApi {
  inspect(request: ProjectIdentityRequest): Promise<Result<ProjectView>>;
  list(request: z.input<typeof ProjectListRequestSchema>): Promise<Result<readonly ProjectView[]>>;
}
