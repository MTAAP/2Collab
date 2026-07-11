import { discoverProject } from "../../runner/repository/discovery.ts";
import { ProjectViewSchema, type ProjectView } from "../../shared/contracts/projects.ts";
import type { ProjectsApi } from "../ports/projects-api.ts";

export type CurrentProjectView = Readonly<{
  project: ProjectView;
  runState: "RUN_STATE_UNAVAILABLE";
}>;

export async function listCurrentProject(
  cwd: string,
  projectsApi: ProjectsApi,
): Promise<CurrentProjectView> {
  const discovered = await discoverProject(cwd);
  const remote = await projectsApi.inspect({
    serverOrigin: discovered.config.serverUrl,
    projectId: discovered.config.projectId,
  });
  if (!remote.ok) throw new Error(remote.error.code);
  const project = ProjectViewSchema.safeParse(remote.value);
  if (
    !project.success ||
    project.data.id !== discovered.config.projectId ||
    project.data.teamId !== discovered.config.teamId ||
    project.data.baseBranch !== discovered.config.baseBranch
  ) {
    throw new Error("PROJECT_IDENTITY_MISMATCH");
  }
  return { project: project.data as ProjectView, runState: "RUN_STATE_UNAVAILABLE" };
}
