import { ProjectConfigSchema, type GitRef } from "../../shared/contracts/projects.ts";

const MAX_PROJECT_CONFIG_BYTES = 16 * 1024;

export type ProjectConfig = Readonly<{
  projectId: string;
  teamId: string;
  serverUrl: string;
  baseBranch: GitRef;
}>;

function invalidConfig(): never {
  throw new Error("PROJECT_CONFIG_INVALID");
}

export function parseProjectConfig(source: string): ProjectConfig {
  if (
    Buffer.byteLength(source, "utf8") > MAX_PROJECT_CONFIG_BYTES ||
    source.includes("\0") ||
    [...source].some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code < 32 && character !== "\n" && character !== "\r" && character !== "\t") ||
        code === 127
      );
    })
  ) {
    return invalidConfig();
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source);
  } catch {
    return invalidConfig();
  }
  const result = ProjectConfigSchema.safeParse(parsed);
  if (!result.success) return invalidConfig();
  return {
    projectId: result.data.project_id,
    teamId: result.data.team_id,
    serverUrl: result.data.server_url,
    baseBranch: result.data.base_branch,
  };
}

export function serializeProjectConfig(config: ProjectConfig): string {
  const parsed = ProjectConfigSchema.safeParse({
    project_id: config.projectId,
    team_id: config.teamId,
    server_url: config.serverUrl,
    base_branch: config.baseBranch,
  });
  if (!parsed.success) return invalidConfig();
  const quote = (value: string) => JSON.stringify(value);
  return [
    `project_id = ${quote(parsed.data.project_id)}`,
    `team_id = ${quote(parsed.data.team_id)}`,
    `server_url = ${quote(parsed.data.server_url)}`,
    `base_branch = ${quote(parsed.data.base_branch)}`,
    "",
  ].join("\n");
}
