import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

const ProjectMappingSchema = z
  .object({
    projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    repositoryId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    mappingRevision: z.number().int().positive(),
    checkout: z.string().min(1).max(4_096),
    baseBranch: z.string().min(1).max(255),
    remoteName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    remoteIdentity: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    remoteRef: z.string().min(1).max(255),
  })
  .strict()
  .refine(
    (mapping) => isAbsolute(mapping.checkout) && resolve(mapping.checkout) === mapping.checkout,
  );

const ConfigurationSchema = z
  .object({
    schemaVersion: z.literal(1),
    projects: z.array(ProjectMappingSchema).max(128),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.projects.map(
      (mapping) => `${mapping.projectId}\0${mapping.mappingRevision}`,
    );
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        message: "duplicate project mapping",
      });
  });

export type LocalRunnerProjectMapping = Readonly<z.infer<typeof ProjectMappingSchema>>;

function load(path: string): z.infer<typeof ConfigurationSchema> {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 * 1024)
      throw new Error("RUNNER_CONFIGURATION_UNSAFE");
    return ConfigurationSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: 1, projects: [] };
    if (error instanceof Error && error.message === "RUNNER_CONFIGURATION_UNSAFE") throw error;
    throw new Error("RUNNER_CONFIGURATION_INVALID");
  }
}

export function createLocalRunnerConfiguration(path: string) {
  if (!isAbsolute(path)) throw new Error("RUNNER_CONFIGURATION_UNSAFE");
  return {
    listProjects(): readonly LocalRunnerProjectMapping[] {
      return load(path).projects;
    },
    resolveProject(projectId: string, mappingRevision: number): LocalRunnerProjectMapping {
      const matches = load(path).projects.filter(
        (entry) => entry.projectId === projectId && entry.mappingRevision === mappingRevision,
      );
      if (matches.length !== 1) throw new Error("RUNNER_PROJECT_MAPPING_UNAVAILABLE");
      const match = matches[0];
      if (!match) throw new Error("RUNNER_PROJECT_MAPPING_UNAVAILABLE");
      return match;
    },
    saveProject(mapping: LocalRunnerProjectMapping): LocalRunnerProjectMapping {
      const parsed = ProjectMappingSchema.parse(mapping);
      const current = load(path);
      const projects = current.projects.filter(
        (entry) =>
          entry.projectId !== parsed.projectId || entry.mappingRevision !== parsed.mappingRevision,
      );
      projects.push(parsed);
      const encoded = `${JSON.stringify({ schemaVersion: 1, projects }, null, 2)}\n`;
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const temporary = `${path}.${process.pid}.${Bun.randomUUIDv7()}.tmp`;
      writeFileSync(temporary, encoded, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
      chmodSync(path, 0o600);
      return parsed;
    },
  };
}

export type LocalRunnerConfiguration = ReturnType<typeof createLocalRunnerConfiguration>;
