import type { LocalProjectRegistry } from "../../runner/repository/global-registry.ts";
import type { ProjectsApi } from "../ports/projects-api.ts";
import { listCurrentProject } from "./list.ts";
import { listKnownProjects } from "./projects.ts";

export async function projectStatus(
  options: Readonly<{ cwd: string; all?: boolean }>,
  dependencies: Readonly<{ projectsApi: ProjectsApi; registry?: LocalProjectRegistry }>,
) {
  if (options.all) {
    if (!dependencies.registry) throw new Error("PROJECT_REGISTRY_UNAVAILABLE");
    return listKnownProjects(dependencies.registry, dependencies.projectsApi);
  }
  try {
    return await listCurrentProject(options.cwd, dependencies.projectsApi);
  } catch (error) {
    if (
      error instanceof Error &&
      ["PROJECT_REPOSITORY_NOT_FOUND", "PROJECT_CONFIG_NOT_FOUND"].includes(error.message)
    ) {
      return {
        error: "PROJECT_NOT_IN_REPOSITORY" as const,
        hint: "Run 'collab status --all' to show known projects." as const,
      };
    }
    throw error;
  }
}
