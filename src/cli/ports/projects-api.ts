import type { Result } from "../../shared/contracts/result.ts";
import type { ProjectView } from "../../shared/contracts/projects.ts";

export type ProjectIdentityRequest = Readonly<{
  serverOrigin: string;
  projectId: string;
}>;

export interface ProjectsApi {
  inspect(request: ProjectIdentityRequest): Promise<Result<ProjectView>>;
  list(request: Readonly<{ serverOrigin: string }>): Promise<Result<readonly ProjectView[]>>;
}
