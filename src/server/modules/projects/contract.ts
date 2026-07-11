import type { Result } from "../../../shared/contracts/result.ts";
import type {
  CreateProject,
  InspectProject,
  ListProjects,
  Project,
} from "../../../shared/contracts/projects.ts";

export interface ProjectRegistry {
  create(command: CreateProject): Promise<Result<Project>>;
  inspect(query: InspectProject): Promise<Result<Project>>;
  list(query: ListProjects): Promise<Result<readonly Project[]>>;
}
