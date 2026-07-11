import type { Database } from "bun:sqlite";

const TABLES = [
  "team_run_template_versions",
  "team_workflow_template_versions",
  "workflow_canvas_layouts",
  "workflow_drafts",
  "workflow_draft_history",
  "personal_workflow_presets",
  "template_registry_writes",
] as const;

export function verifyWorkflowsSchema(database: Database): void {
  const versions = database
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  if (versions.length < 13 || versions.slice(0, 13).some((row, index) => row.version !== index + 1))
    throw new Error("SCHEMA_MIGRATION_HISTORY_INVALID");
  for (const table of TABLES) {
    if (database.query<{ strict: number }, []>(`PRAGMA table_list('${table}')`).get()?.strict !== 1)
      throw new Error("SCHEMA_INTEGRITY_INVALID");
  }
}
