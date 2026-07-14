import { discoverProject, isPrimaryCheckout } from "../../runner/repository/discovery.ts";
import type { LocalProjectRegistry } from "../../runner/repository/global-registry.ts";
import type { ProjectId } from "../../shared/contracts/ids.ts";
import { ProjectViewSchema, type ProjectView } from "../../shared/contracts/projects.ts";
import type { ProjectsApi } from "../ports/projects-api.ts";

export type CurrentProjectView = Readonly<{
  project: ProjectView;
  runState: "RUN_STATE_UNAVAILABLE";
}>;

export async function listCurrentProject(
  cwd: string,
  projectsApi: ProjectsApi,
  registry?: LocalProjectRegistry,
): Promise<CurrentProjectView> {
  const discovered = await discoverProject(cwd);
  const remote = await projectsApi.inspect({
    serverOrigin: discovered.config.serverUrl,
    projectId: discovered.config.projectId as ProjectId,
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
  if (registry && (await isPrimaryCheckout(discovered.root))) {
    const existing = registry.lookup({
      serverOrigin: discovered.config.serverUrl,
      projectId: discovered.config.projectId,
    });
    if (!existing || existing.preferredCheckout === discovered.root) {
      registry.register({
        serverOrigin: discovered.config.serverUrl,
        projectId: discovered.config.projectId,
        teamId: discovered.config.teamId,
        baseBranch: discovered.config.baseBranch,
        preferredCheckout: discovered.root,
        configSha256: discovered.configSha256,
      });
    }
  }
  return { project: project.data as ProjectView, runState: "RUN_STATE_UNAVAILABLE" };
}
