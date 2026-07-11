import type { Result } from "../../../shared/contracts/result.ts";
import type {
  BindWorkflowPreset,
  PersonalWorkflowPreset,
  PublishRunTemplate,
  TeamRunTemplateVersion,
} from "../../../shared/contracts/templates.ts";
import type { PublishWorkflowTemplate, TeamWorkflowTemplateVersion } from "./versioning.ts";

export interface TemplateRegistry {
  publishRunTemplate(command: PublishRunTemplate): Promise<Result<TeamRunTemplateVersion>>;
  publishWorkflowTemplate(
    command: PublishWorkflowTemplate,
  ): Promise<Result<TeamWorkflowTemplateVersion>>;
  bind(command: BindWorkflowPreset): Promise<Result<PersonalWorkflowPreset>>;
}
