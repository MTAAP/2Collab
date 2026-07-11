import type { LocalProjectRegistry } from "../../runner/repository/global-registry.ts";
import { ProjectViewSchema, type ProjectView } from "../../shared/contracts/projects.ts";
import type { ProjectsApi } from "../ports/projects-api.ts";

export type KnownProjectView =
  | Readonly<{
      serverOrigin: string;
      projectId: string;
      state: "AVAILABLE";
      project: ProjectView;
      runState: "RUN_STATE_UNAVAILABLE";
    }>
  | Readonly<{
      serverOrigin: string;
      projectId: string;
      state: "STALE" | "UNREACHABLE";
      errorCode: string;
    }>;

export async function listKnownProjects(
  registry: LocalProjectRegistry,
  projectsApi: ProjectsApi,
): Promise<readonly KnownProjectView[]> {
  return Promise.all(
    registry.list().map(async (mapping) => {
      const remote = await projectsApi.inspect({
        serverOrigin: mapping.serverOrigin,
        projectId: mapping.projectId,
      });
      if (!remote.ok) {
        return {
          serverOrigin: mapping.serverOrigin,
          projectId: mapping.projectId,
          state: remote.error.code === "SERVER_UNREACHABLE" ? "UNREACHABLE" : "STALE",
          errorCode: remote.error.code,
        } as const;
      }
      const project = ProjectViewSchema.safeParse(remote.value);
      if (
        !project.success ||
        project.data.id !== mapping.projectId ||
        project.data.teamId !== mapping.teamId ||
        project.data.baseBranch !== mapping.baseBranch
      ) {
        return {
          serverOrigin: mapping.serverOrigin,
          projectId: mapping.projectId,
          state: "STALE",
          errorCode: "PROJECT_IDENTITY_MISMATCH",
        } as const;
      }
      return {
        serverOrigin: mapping.serverOrigin,
        projectId: mapping.projectId,
        state: "AVAILABLE",
        project: project.data as ProjectView,
        runState: "RUN_STATE_UNAVAILABLE",
      } as const;
    }),
  );
}
