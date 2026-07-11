# Bounded Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `AUT-001` through `AUT-014` as portable, typed, bounded, restart-safe workflow automation that composes Foundation `ExecutionAuthority` and GitHub exact-revision evidence without adding a privileged execution path.

**Architecture:** `WorkflowEngine`, `TemplateRegistry`, and `GateCoordinator` are shared-server modules over SQLite. Every executable step creates an ordinary Agent Run through `ExecutionAuthority.execute`; React Flow, YAML, HTTP, CLI, and MCP are adapters over the canonical seven-node `WorkflowDefinition`, while `CanvasLayout` remains independently versioned presentation state. Local fixtures prove behavior; the evidence ledger keeps live GitHub and Claude/Codex proof explicitly non-PASS until executed.

**Tech Stack:** Bun 1.3.10, TypeScript 7.0.2, Hono 4.12.29, React 19.2.7, Vite 8.1.4, `@xyflow/react` 12.11.2, Zod 4.4.3, `bun:sqlite`, Bun test, Playwright 1.61.1, YAML 2.9.0, Docker Compose.

## Global Constraints

- The Product Spec remains canonical; accepted ADRs and the reconciliation design govern implementation shape only when consistent with it.
- Keep one root `package.json`, one `bun.lock`, and exact dependency versions; add no workspace, ORM, PostgreSQL abstraction, broker, worker artifact, or second workflow graph.
- Allowed imports are `shared contracts <- domain <- server or runner modules <- adapters and composition roots`.
- Persist enum-like values as UPPERCASE strings.
- Every write carries an idempotency key, authenticated actor, expected revision, and structured `Result`.
- Workflow code never parses prompts, logs, terminal text, comments, prose evidence, or process exit code to select a transition.
- Every Agent Run step crosses `ExecutionAuthority.execute`; workflows never create permits, sessions, worktrees, connector authority, mutation overrides, or provider calls directly.
- Parallel workflow branches are `INSPECT_ONLY`; mutating branches under one Coordination Record are rejected.
- React Flow objects are derived editor state. Only `WorkflowDefinition` is executable; `CanvasLayout` contains positions, viewport, and collapsed groups.
- Raw prompts, terminal transcripts, source bodies, raw diffs, environments, credentials, private profile arguments, absolute paths, and worktree contents never enter durable server storage.
- Absolute run and workflow deadlines are positive, finite, snapshotted, and continue through `WAITING`, `PAUSED`, and restart.
- Expected errors use stable uppercase codes and bounded safe messages; internal failures expose only correlation identifiers.
- Write the failing Bun test first, observe a behavioral RED, add the smallest implementation, run GREEN plus typecheck/lint, then commit.
- Live evidence is additional. Strict fixtures cannot mark `AUT-014` or another provider-backed proof `PASS`.
- Do not push, merge, publish, mutate production connectors, or post public comments without explicit authority.

---

## File Map

| Path | Responsibility |
|---|---|
| `src/shared/contracts/templates.ts` | Portable Team Run Template and personal binding schemas |
| `src/shared/contracts/workflow.ts` | Canonical seven-node Workflow Definition, Canvas Layout, drafts, versions, executions |
| `src/shared/contracts/workflow-results.ts` | Typed step/system results and join policies |
| `src/shared/contracts/plan-artifacts.ts` | Bounded portable Plan Artifact |
| `src/shared/contracts/gates.ts` | Gate manifest summaries, fingerprints, evaluations |
| `src/shared/contracts/stop-policies.ts` | Three-valued Stop Policy trees and evaluation evidence |
| `src/server/db/migrations/0012_workflows.sql` | Run templates, workflow templates, layouts, drafts, presets |
| `src/server/db/migrations/0013_workflow_execution.sql` | Executions, step occurrences, launch intents, decisions |
| `src/server/db/migrations/0014_gates_telemetry.sql` | Gate approvals/evaluations, loop state, workflow usage |
| `src/server/modules/templates/` | Template publication, sanitization, versioning, bindings |
| `src/server/modules/workflows/` | Definition validation, drafts/YAML, engine, scheduling, joins, decisions, planning, loops |
| `src/server/modules/gates/` | Gate coordination and exact-revision evidence |
| `src/server/modules/telemetry/workflow-usage.ts` | Partial workflow aggregation with gate time separated |
| `src/runner/gates/` | Trusted-base TOML loading and local no-shell evaluation |
| `src/server/adapters/http/routes/{templates,workflows}.ts` | Thin authenticated Hono adapters |
| `src/server/adapters/mcp/{template-tools,workflow-tools}.ts` | Thin schema-based MCP adapters |
| `src/cli/commands/{templates,workflows}.ts` | CLI inspect/publish/bind/start/show/pause/resume/cancel/import/export |
| `src/web/features/templates/` | Team Run Template library and binding UI |
| `src/web/features/workflow-studio/` | React Flow editor, inspector, validation, history, YAML, structured outline |
| `src/web/features/workflows/` | Execution timeline, decisions, Plan Artifact presentation |
| `tests/fixtures/workflows/` | Valid and invalid canonical definitions plus strict event fixtures |
| `tests/unit/{templates,workflows,gates}/` | Pure schema, validation, hashing, joins, stop policy, telemetry tests |
| `tests/integration/{templates,workflows,gates}/` | Real SQLite and strict in-memory authority/provider adapter tests |
| `tests/protocol/` | HTTP/CLI/MCP parity and adapter-thinness tests |
| `tests/runner/gates/` | Temporary-repository gate conformance tests |
| `tests/e2e/` | Authoring, planning, decisions, and bounded automation journeys |
| `tests/drills/` | Restart, duplicate-event, deadline, revocation, no-parked-process drills |
| `docs/evidence/bounded-automation/AUTOMATION-EVIDENCE-LEDGER.md` | Strict separation of local proof and live disposable-resource proof |

## Required Existing Interfaces

All tasks consume these Foundation/GitHub interfaces exactly; do not introduce alternates:

```ts
export interface ExecutionAuthority {
  preview(request: AuthorityPreviewRequest): Promise<AuthorityPreview>;
  execute<C extends CollabCommand>(command: C): Promise<Result<CommandResultFor<C>>>;
  query<Q extends CoordinationQuery>(query: Q): Promise<Result<QueryResultFor<Q>>>;
}

export interface GitHubPort extends SourceConnector<GitHubReference, GitHubProjection, GitHubMutation> {
  observeChecks(reference: PublishedGitReference): Promise<Result<readonly GitHubCheckObservation[]>>;
  listDependencies(reference: GitHubWorkItemReference): Promise<Result<Observed<readonly SourceDependency[]>>>;
}
```

---

### Task 1: Portable Team Run Templates and Migration 0012 (`AUT-001`)

**Files:**
- Create: `src/server/db/migrations/0012_workflows.sql`
- Create: `src/server/db/migrations/0012_workflows.verify.ts`
- Modify: `src/server/db/migrate.ts`
- Create: `src/shared/contracts/templates.ts`
- Create: `src/server/modules/templates/{contract,run-templates,versioning}.ts`
- Test: `tests/unit/templates/portable-template.test.ts`
- Test: `tests/integration/templates/run-templates.test.ts`

**Interfaces:**
- Consumes: `Result<T>`, `MemberActor`, `ContextRecipeId`, `ProjectId`, `RepositoryMode`, `RepositoryAssurance`.
- Produces:

```ts
export interface TemplateRegistry {
  publishRunTemplate(command: PublishRunTemplate): Promise<Result<TeamRunTemplateVersion>>;
  publishWorkflowTemplate(command: PublishWorkflowTemplate): Promise<Result<TeamWorkflowTemplateVersion>>;
  bind(command: BindWorkflowPreset): Promise<Result<PersonalWorkflowPreset>>;
}
```

- [ ] **Step 1: Write the failing portability test**

```ts
import { expect, test } from "bun:test";
import { sanitizeRunTemplate } from "../../../src/server/modules/templates/run-templates";

test("removes no private execution data and rejects it instead", () => {
  expect(() => sanitizeRunTemplate({
    name: "Review",
    coreInstructions: "Review the published revision.",
    variables: [{ key: "goal", type: "STRING", required: true }],
    resultKeys: ["APPROVED", "CHANGES_REQUESTED"],
    repositoryMode: "INSPECT_ONLY",
    minimumAssurance: "ADVISORY",
    contextRecipeId: "recipe_review",
    gateSets: ["REVIEW"],
    privateRunnerId: "runner_private",
  })).toThrow("TEMPLATE_PRIVATE_EXECUTION_DATA");
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/templates/portable-template.test.ts`

Expected: FAIL with `Cannot find module '../../../src/server/modules/templates/run-templates'`.

- [ ] **Step 3: Add the exact template contract and sanitization**

```ts
export type TeamRunTemplateDraft = Readonly<{
  name: string;
  description?: string;
  projectId?: ProjectId;
  coreInstructions: string;
  variables: readonly Readonly<{ key: string; type: "STRING" | "NUMBER" | "BOOLEAN"; required: boolean }>[];
  resultKeys: readonly string[];
  repositoryMode: "MUTATING" | "INSPECT_ONLY";
  minimumAssurance: "ADVISORY" | "ENFORCED";
  contextRecipeId?: ContextRecipeId;
  gateSets: readonly string[];
  maximumAttempts: number;
  absoluteDeadlineMs: number;
}>;

export type TeamRunTemplateVersion = Readonly<{
  id: string;
  templateKey: string;
  version: number;
  definition: TeamRunTemplateDraft;
  semanticHash: string;
}>;

export const TeamRunTemplateDraftSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  projectId: z.string().min(1).optional(),
  coreInstructions: z.string().min(1).max(16_000),
  variables: z.array(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*$/), type: z.enum(["STRING", "NUMBER", "BOOLEAN"]), required: z.boolean() }).strict()).max(64),
  resultKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1).max(32),
  repositoryMode: z.enum(["MUTATING", "INSPECT_ONLY"]),
  minimumAssurance: z.enum(["ADVISORY", "ENFORCED"]),
  contextRecipeId: z.string().min(1).optional(),
  gateSets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(32),
  maximumAttempts: z.number().int().positive(),
  absoluteDeadlineMs: z.number().int().positive(),
}).strict();

const forbiddenTemplateKeys = new Set([
  "privateRunnerId", "personalRunPresetId", "profileVersionId", "executable",
  "arguments", "environment", "credential", "documentWriteGrantId",
]);

export function sanitizeRunTemplate(input: Record<string, unknown>): TeamRunTemplateDraft {
  for (const key of Object.keys(input)) {
    if (forbiddenTemplateKeys.has(key)) throw new Error("TEMPLATE_PRIVATE_EXECUTION_DATA");
  }
  return TeamRunTemplateDraftSchema.parse(input);
}
```

- [ ] **Step 4: Add the first migration with immutable template versions**

```sql
CREATE TABLE team_run_template_versions (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  project_id TEXT,
  definition_json TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  published_by_member_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (template_key, version),
  UNIQUE (template_key, semantic_hash)
) STRICT;

CREATE TABLE team_workflow_template_versions (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  definition_json TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  published_by_member_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE (template_key, version),
  UNIQUE (template_key, semantic_hash)
) STRICT;

CREATE TABLE workflow_canvas_layouts (
  workflow_template_version_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  layout_json TEXT NOT NULL,
  layout_hash TEXT NOT NULL,
  saved_by_member_id TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (workflow_template_version_id, revision)
) STRICT;
```

- [ ] **Step 5: Run GREEN and migration verification**

Run: `bun test tests/unit/templates/portable-template.test.ts tests/integration/templates/run-templates.test.ts src/server/db/migrations/0012_workflows.verify.ts && bun run typecheck && bun run lint`

Expected: PASS; verifier proves existing versions remain byte-identical after publishing a new version.

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts/templates.ts src/server/db/migrations/0012_workflows.sql src/server/db/migrations/0012_workflows.verify.ts src/server/db/migrate.ts src/server/modules/templates tests/unit/templates tests/integration/templates
git commit -m "feat(automation): add portable run templates"
```

### Task 2: Canonical Seven-Node Definition and Separate Canvas Layout (`AUT-002`)

**Files:**
- Create: `src/shared/contracts/workflow.ts`
- Create: `src/server/modules/workflows/{definition,versioning}.ts`
- Test: `tests/unit/workflows/definition.test.ts`
- Test: `tests/unit/workflows/layout.test.ts`

**Interfaces:**
- Consumes: versioned Team Run Template identifiers from Task 1.
- Produces: `WorkflowDefinitionSchema`, `CanvasLayoutSchema`, `semanticHash()`, `layoutHash()`.

- [ ] **Step 1: Write the failing semantic/layout separation test**

```ts
test("layout changes do not change workflow semantics", () => {
  const a = semanticHash(validDefinition);
  const moved = { ...validLayout, nodes: [{ key: "implement", x: 800, y: 120, collapsed: false }] };
  expect(semanticHash(validDefinition)).toBe(a);
  expect(layoutHash(moved)).not.toBe(layoutHash(validLayout));
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/workflows/definition.test.ts tests/unit/workflows/layout.test.ts`

Expected: FAIL with missing `WorkflowDefinitionSchema`.

- [ ] **Step 3: Implement the exact canonical contracts**

```ts
export type ResultRouterNode = Readonly<{
  kind: "RESULT_ROUTER";
  key: string;
  sourceStepKey: string;
  routes: Readonly<Record<string, string>>;
  fallbackTargetKey: string;
}>;

export type JoinNode = Readonly<{
  kind: "JOIN";
  key: string;
  branchKeys: readonly string[];
  policy: "ALL" | "ANY";
  acceptedResultKeys: readonly string[];
  fallbackTargetKey: string;
  remainderPolicy?: "CANCEL_REMAINDER" | "LET_FINISH";
}>;

export type WorkflowNode =
  | Readonly<{ kind: "START"; key: string }>
  | Readonly<{ kind: "AGENT_RUN"; key: string; runTemplateVersionId: string; resultKeys: readonly string[] }>
  | Readonly<{ kind: "HUMAN_DECISION"; key: string; choices: readonly string[] }>
  | ResultRouterNode
  | Readonly<{ kind: "PARALLEL_SPLIT"; key: string; branchKeys: readonly string[] }>
  | JoinNode
  | Readonly<{ kind: "TERMINAL"; key: string; outcome: "COMPLETED" | "FAILED" | "CANCELLED" }>;

export type WorkflowDefinition = Readonly<{
  inputs: readonly Readonly<{ key: string; type: "STRING" | "NUMBER" | "BOOLEAN"; required: boolean }>[];
  nodes: readonly WorkflowNode[];
  transitions: readonly Readonly<{ from: string; resultKey: string; to: string }>[];
  maximumRunCount: number;
  cycleBounds: Readonly<Record<string, number>>;
  maximumParallelBranches: number;
  maximumConcurrency: number;
  absoluteDeadlineMs: number;
}>;

export type CanvasLayout = Readonly<{
  nodes: readonly Readonly<{ key: string; x: number; y: number; collapsed: boolean }>[];
  viewport: Readonly<{ x: number; y: number; zoom: number }>;
  collapsedGroups: readonly string[];
}>;
```

- [ ] **Step 4: Implement deterministic independent hashes**

```ts
import { createHash } from "node:crypto";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const semanticHash = (definition: WorkflowDefinition) => createHash("sha256").update(stable(definition)).digest("hex");
export const layoutHash = (layout: CanvasLayout) => createHash("sha256").update(stable(layout)).digest("hex");
```

- [ ] **Step 5: Run GREEN**

Run: `bun test tests/unit/workflows/definition.test.ts tests/unit/workflows/layout.test.ts && bun run typecheck && bun run lint`

Expected: PASS; a semantic edit changes only the semantic hash and a position edit changes only the layout hash.

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts/workflow.ts src/server/modules/workflows/definition.ts src/server/modules/workflows/versioning.ts tests/unit/workflows/definition.test.ts tests/unit/workflows/layout.test.ts
git commit -m "feat(automation): define canonical workflow schema"
```

### Task 3: Authoritative Workflow Validation (`AUT-003`)

**Files:**
- Create: `src/server/modules/workflows/validation.ts`
- Create: `tests/fixtures/workflows/{valid,missing-terminal,missing-fix,unbounded-cycle,unsafe-join,incompatible-result,unreachable,parallel-mutator}.ts`
- Test: `tests/unit/workflows/validation.test.ts`

**Interfaces:**
- Consumes: `WorkflowDefinition` from Task 2 and template repository modes from Task 1.
- Produces:

```ts
export type WorkflowDiagnostic = Readonly<{ path: string; code: string; message: string }>;
export function validateWorkflow(definition: WorkflowDefinition, templates: ReadonlyMap<string, TeamRunTemplateVersion>): readonly WorkflowDiagnostic[];
```

- [ ] **Step 1: Write the failing table-driven negative test**

```ts
test.each([
  [missingTerminal, "WORKFLOW_TERMINAL_REQUIRED"],
  [unboundedCycle, "WORKFLOW_CYCLE_BOUND_REQUIRED"],
  [unsafeJoin, "WORKFLOW_JOIN_INVALID"],
  [parallelMutator, "WORKFLOW_PARALLEL_MUTATION_FORBIDDEN"],
])("rejects invalid graphs with stable diagnostics", (definition, code) => {
  expect(validateWorkflow(definition, templates).map((item) => item.code)).toContain(code);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/workflows/validation.test.ts`

Expected: FAIL with missing `validateWorkflow`.

- [ ] **Step 3: Implement validation in one pure pass**

```ts
export function validateWorkflow(definition: WorkflowDefinition, templates: ReadonlyMap<string, TeamRunTemplateVersion>) {
  const diagnostics: WorkflowDiagnostic[] = [];
  const byKey = new Map(definition.nodes.map((node) => [node.key, node]));
  const starts = definition.nodes.filter((node) => node.kind === "START");
  if (starts.length !== 1) diagnostics.push({ path: "nodes", code: "WORKFLOW_START_REQUIRED", message: "Exactly one START node is required." });
  if (!definition.nodes.some((node) => node.kind === "TERMINAL")) diagnostics.push({ path: "nodes", code: "WORKFLOW_TERMINAL_REQUIRED", message: "At least one TERMINAL node is required." });
  if (definition.maximumRunCount < 1 || definition.maximumConcurrency < 1 || definition.absoluteDeadlineMs < 1) diagnostics.push({ path: "bounds", code: "WORKFLOW_BOUND_INVALID", message: "All workflow bounds must be positive." });
  for (const [index, node] of definition.nodes.entries()) {
    if (node.kind === "AGENT_RUN" && !templates.has(node.runTemplateVersionId)) diagnostics.push({ path: `nodes[${index}].runTemplateVersionId`, code: "RUN_TEMPLATE_VERSION_STALE", message: "The referenced Run Template version is unavailable." });
    if (node.kind === "JOIN" && node.policy === "ANY" && !node.remainderPolicy) diagnostics.push({ path: `nodes[${index}].remainderPolicy`, code: "WORKFLOW_JOIN_INVALID", message: "ANY joins require a remainder policy." });
    if (node.kind === "PARALLEL_SPLIT" && node.branchKeys.some((key) => { const branch = byKey.get(key); return branch?.kind === "AGENT_RUN" && templates.get(branch.runTemplateVersionId)?.repositoryMode === "MUTATING"; })) diagnostics.push({ path: `nodes[${index}].branchKeys`, code: "WORKFLOW_PARALLEL_MUTATION_FORBIDDEN", message: "Parallel branches must be INSPECT_ONLY." });
  }
  return diagnostics;
}
```

- [ ] **Step 4: Run GREEN**

Run: `bun test tests/unit/workflows/validation.test.ts && bun run typecheck && bun run lint`

Expected: PASS for the valid fixture and stable path-addressed codes for every invalid fixture.

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/workflows/validation.ts tests/fixtures/workflows tests/unit/workflows/validation.test.ts
git commit -m "feat(automation): validate bounded workflow definitions"
```

### Task 4: Shared Drafts, History, YAML, HTTP/CLI/MCP Parity, and Accessibility

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `src/server/db/migrations/0012_workflows.sql`
- Create: `src/server/modules/workflows/{drafts,yaml}.ts`
- Create: `src/server/adapters/http/routes/workflows.ts`
- Create: `src/server/adapters/mcp/workflow-tools.ts`
- Create: `src/cli/commands/workflows.ts`
- Create: `src/web/features/workflow-studio/{editor,definition-adapter,validation-panel,structured-outline,history,yaml-io}.tsx`
- Test: `tests/integration/workflows/drafts.test.ts`
- Test: `tests/protocol/workflow-authoring-parity.test.ts`
- Test: `tests/e2e/workflow-authoring.spec.ts`

**Interfaces:**
- Consumes: Task 2 schemas and Task 3 validator.
- Produces: revisioned `WorkflowDraft`, `saveDraft`, `duplicateDraft`, `importWorkflowYaml`, `exportWorkflowYaml`.

- [ ] **Step 1: Write the failing stale-draft and YAML sanitization tests**

```ts
test("a stale save cannot overwrite another member", async () => {
  await drafts.save({ ...baseSave, expectedRevision: 1, definition: firstEdit });
  const stale = await drafts.save({ ...baseSave, expectedRevision: 1, definition: secondEdit });
  expect(stale).toMatchObject({ ok: false, error: { code: "WORKFLOW_DRAFT_REVISION_STALE" } });
});

test("YAML import rejects personal bindings and React Flow objects", () => {
  expect(() => importWorkflowYaml("personalRunPresetId: private\nreactFlowNodes: []")).toThrow("WORKFLOW_IMPORT_PRIVATE_DATA");
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/workflows/drafts.test.ts tests/protocol/workflow-authoring-parity.test.ts`

Expected: FAIL with missing drafts and YAML modules.

- [ ] **Step 3: Pin the YAML adapter and add revisioned draft storage**

Run: `bun add --exact yaml@2.9.0`

Expected: `package.json` records `"yaml": "2.9.0"` and `bun.lock` changes once.

```sql
CREATE TABLE workflow_drafts (
  id TEXT PRIMARY KEY,
  template_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  definition_json TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  updated_by_member_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE workflow_draft_history (
  draft_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  definition_json TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  authored_by_member_id TEXT NOT NULL,
  authored_at TEXT NOT NULL,
  PRIMARY KEY (draft_id, revision)
) STRICT;
```

- [ ] **Step 4: Implement strict YAML import/export**

```ts
import { parseDocument, stringify } from "yaml";

const forbiddenImportKeys = new Set(["personalRunPresetId", "runnerId", "profileVersionId", "command", "environment", "credential", "reactFlowNodes", "reactFlowEdges"]);

export function importWorkflowYaml(source: string): WorkflowDefinition {
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length) throw new Error("WORKFLOW_YAML_INVALID");
  const value = document.toJS() as Record<string, unknown>;
  if (Object.keys(value).some((key) => forbiddenImportKeys.has(key))) throw new Error("WORKFLOW_IMPORT_PRIVATE_DATA");
  return WorkflowDefinitionSchema.parse(value);
}

export function exportWorkflowYaml(definition: WorkflowDefinition): string {
  return stringify(WorkflowDefinitionSchema.parse(definition), { sortMapEntries: true });
}
```

- [ ] **Step 5: Implement the accessible React Flow seam**

```tsx
export function StructuredWorkflowOutline({ definition, select }: { definition: WorkflowDefinition; select: (key: string) => void }) {
  return <nav aria-label="Workflow structure"><ol>{definition.nodes.map((node) =>
    <li key={node.key}><button type="button" onClick={() => select(node.key)} aria-label={`${node.kind} ${node.key}`}>{node.key}</button></li>
  )}</ol></nav>;
}

export const toReactFlow = (definition: WorkflowDefinition, layout: CanvasLayout) => ({
  nodes: definition.nodes.map((node) => ({ id: node.key, type: node.kind, data: { node }, position: layout.nodes.find((item) => item.key === node.key) ?? { x: 0, y: 0 } })),
  edges: definition.transitions.map((edge, index) => ({ id: `edge-${index}`, source: edge.from, target: edge.to, label: edge.resultKey })),
});
```

- [ ] **Step 6: Run GREEN including browser keyboard proof**

Run: `bun test tests/integration/workflows/drafts.test.ts tests/protocol/workflow-authoring-parity.test.ts && bun run test:e2e:run -- workflow-authoring.spec.ts && bun run typecheck && bun run lint`

Expected: PASS; keyboard-only authoring, undo/redo, stale duplication, YAML round-trip, and HTTP/CLI/MCP results are semantically identical.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/server/db/migrations/0012_workflows.sql src/server/modules/workflows/drafts.ts src/server/modules/workflows/yaml.ts src/server/adapters/http/routes/workflows.ts src/server/adapters/mcp/workflow-tools.ts src/cli/commands/workflows.ts src/web/features/workflow-studio tests/integration/workflows/drafts.test.ts tests/protocol/workflow-authoring-parity.test.ts tests/e2e/workflow-authoring.spec.ts
git commit -m "feat(automation): add accessible workflow authoring"
```

### Task 5: Personal Workflow Presets and Exact Bindings (`AUT-004`)

**Files:**
- Modify: `src/server/db/migrations/0012_workflows.sql`
- Create: `src/server/modules/templates/{bindings,workflow-presets}.ts`
- Create: `src/server/adapters/http/routes/templates.ts`
- Create: `src/server/adapters/mcp/template-tools.ts`
- Create: `src/cli/commands/templates.ts`
- Create: `src/web/features/templates/workflow-bindings.tsx`
- Test: `tests/integration/workflows/bindings.test.ts`
- Test: `tests/protocol/template-surface-parity.test.ts`

**Interfaces:**
- Consumes: exact Personal Run Preset version queries through `ExecutionAuthority.query`.
- Produces: `BindWorkflowPreset`, `PersonalWorkflowPreset`, `resolveWorkflowBindings`.

- [ ] **Step 1: Write the failing no-substitution test**

```ts
test("missing or stale bindings require an explicit replacement", async () => {
  const result = await resolver.resolve(presetWithStaleReviewBinding);
  expect(result).toMatchObject({ ok: false, error: { code: "PRESET_BINDING_REQUIRED", retry: "EXPLICIT_RESUME" } });
  expect(authority.executeCalls).toHaveLength(0);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/workflows/bindings.test.ts`

Expected: FAIL with missing `workflow-presets` module.

- [ ] **Step 3: Add immutable binding storage and resolver**

```sql
CREATE TABLE personal_workflow_presets (
  id TEXT PRIMARY KEY,
  owner_member_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  workflow_template_version_id TEXT NOT NULL,
  bindings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_member_id, id, version)
) STRICT;
```

```ts
export type PersonalWorkflowPreset = Readonly<{
  id: string;
  ownerMemberId: string;
  version: number;
  workflowTemplateVersionId: string;
  bindings: Readonly<Record<string, Readonly<{ personalRunPresetId: string; expectedVersion: number }>>>;
}>;

export async function resolveWorkflowBindings(preset: PersonalWorkflowPreset, authority: ExecutionAuthority) {
  const resolved = await authority.query({ kind: "RESOLVE_PERSONAL_RUN_PRESET_BINDINGS", bindings: preset.bindings });
  if (!resolved.ok || resolved.value.staleKeys.length > 0) return err("PRESET_BINDING_REQUIRED", "EXPLICIT_RESUME");
  return ok(resolved.value.bindings);
}
```

- [ ] **Step 4: Run GREEN and parity**

Run: `bun test tests/integration/workflows/bindings.test.ts tests/protocol/template-surface-parity.test.ts && bun run typecheck && bun run lint`

Expected: PASS with distinct runtime/model/runner/host/mode bindings and no silent replacement.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/migrations/0012_workflows.sql src/server/modules/templates src/server/adapters/http/routes/templates.ts src/server/adapters/mcp/template-tools.ts src/cli/commands/templates.ts src/web/features/templates tests/integration/workflows/bindings.test.ts tests/protocol/template-surface-parity.test.ts
git commit -m "feat(automation): bind personal workflow execution"
```

### Task 6: Durable Idempotent Workflow Engine and Migration 0013 (`AUT-005`)

**Files:**
- Create: `src/server/db/migrations/0013_workflow_execution.sql`
- Create: `src/server/db/migrations/0013_workflow_execution.verify.ts`
- Modify: `src/server/db/migrate.ts`
- Create: `src/server/modules/workflows/{contract,workflow-engine,scheduler,idempotency,step-run-factory}.ts`
- Test: `tests/integration/workflows/{execution,idempotency,restart}.test.ts`

**Interfaces:**
- Consumes: `ExecutionAuthority.execute({ kind: "LAUNCH_RUN", ... })`; Tasks 2 and 5 snapshots.
- Produces:

```ts
export interface WorkflowEngine {
  publish(command: PublishWorkflowVersion): Promise<Result<WorkflowVersion>>;
  start(command: StartWorkflow): Promise<Result<WorkflowExecution>>;
  accept(command: WorkflowEventCommand): Promise<Result<WorkflowExecution>>;
  decide(command: RecordHumanDecision): Promise<Result<WorkflowExecution>>;
}
```

- [ ] **Step 1: Write the failing restart/idempotency test**

```ts
test("a committed launch intent creates one child run after restart", async () => {
  await engine.start(startCommand);
  scheduler.failAfterIntentCommitOnce();
  await scheduler.tick();
  const restarted = createWorkflowEngine(database, authority);
  await restarted.tick();
  await restarted.accept(duplicateTerminalEvent);
  expect(authority.commands.filter((item) => item.kind === "LAUNCH_RUN")).toHaveLength(1);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/workflows/execution.test.ts tests/integration/workflows/idempotency.test.ts tests/integration/workflows/restart.test.ts`

Expected: FAIL with missing `WorkflowEngine` implementation.

- [ ] **Step 3: Add durable execution tables**

```sql
CREATE TABLE workflow_executions (
  id TEXT PRIMARY KEY,
  coordination_record_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL,
  preset_version_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','WAITING','PAUSED','COMPLETED','FAILED','CANCELLED')),
  snapshot_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  absolute_deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE workflow_step_occurrences (
  id TEXT PRIMARY KEY,
  workflow_execution_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  occurrence INTEGER NOT NULL CHECK (occurrence > 0),
  agent_run_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('PENDING','LAUNCH_INTENT','RUNNING','TERMINAL','CANCELLED')),
  result_json TEXT,
  UNIQUE (workflow_execution_id, node_key, occurrence)
) STRICT;

CREATE TABLE workflow_launch_intents (
  idempotency_key TEXT PRIMARY KEY,
  workflow_execution_id TEXT NOT NULL,
  step_occurrence_id TEXT NOT NULL UNIQUE,
  command_json TEXT NOT NULL,
  dispatched_at TEXT
) STRICT;
```

- [ ] **Step 4: Launch only through ExecutionAuthority**

```ts
export async function dispatchStep(intent: WorkflowLaunchIntent, authority: ExecutionAuthority) {
  return authority.execute({
    kind: "LAUNCH_RUN",
    idempotencyKey: intent.idempotencyKey,
    actor: intent.schedulerActor,
    projectId: intent.projectId,
    coordination: { kind: "EXISTING", coordinationRecordId: intent.coordinationRecordId, expectedRevision: intent.coordinationRevision },
    goal: intent.goal,
    repository: intent.repository,
    execution: intent.execution,
    effectiveConfiguration: intent.effectiveConfiguration,
    workflow: { workflowExecutionId: intent.workflowExecutionId, stepOccurrenceId: intent.stepOccurrenceId, workflowRevision: intent.workflowRevision, effectiveConfigurationDigest: intent.configurationDigest },
  });
}
```

- [ ] **Step 5: Run GREEN and migration verifier**

Run: `bun test tests/integration/workflows/execution.test.ts tests/integration/workflows/idempotency.test.ts tests/integration/workflows/restart.test.ts src/server/db/migrations/0013_workflow_execution.verify.ts && bun run typecheck && bun run lint`

Expected: PASS; one transition intent and at most one Agent Run exist per step occurrence.

- [ ] **Step 6: Commit**

```bash
git add src/server/db/migrations/0013_workflow_execution.sql src/server/db/migrations/0013_workflow_execution.verify.ts src/server/db/migrate.ts src/server/modules/workflows tests/integration/workflows
git commit -m "feat(automation): schedule workflows durably"
```

### Task 7: Parallel Inspect-Only Groups and Typed Joins (`AUT-006`)

**Files:**
- Create: `src/shared/contracts/workflow-results.ts`
- Create: `src/server/modules/workflows/{parallel-groups,results,joins}.ts`
- Test: `tests/unit/workflows/joins.test.ts`
- Test: `tests/integration/workflows/parallel-review.test.ts`

**Interfaces:**
- Consumes: Task 6 launch intents and Foundation terminal Agent Run queries.
- Produces: `WorkflowStepResult`, `evaluateJoin`.

- [ ] **Step 1: Write the failing ANY race test**

```ts
test("ANY accepts one matching result and applies CANCEL_REMAINDER once", () => {
  const first = evaluateJoin(anyJoin, { terminalBranchKeys: [] }, results.cleanClaude);
  const raced = evaluateJoin(anyJoin, first.state, results.majorCodex);
  expect(first.transition?.targetKey).toBe("terminal");
  expect(first.cancelKeys).toEqual(["codex-review"]);
  expect(raced.transition).toBeUndefined();
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/workflows/joins.test.ts tests/integration/workflows/parallel-review.test.ts`

Expected: FAIL with missing join evaluator.

- [ ] **Step 3: Implement typed results and serialized joins**

```ts
export type WorkflowStepResult = Readonly<{
  stepOccurrenceId: string;
  runId: string;
  key: string;
  artifacts: readonly Readonly<{ kind: string; reference: string; revision: string }>[];
}>;

export type JoinState = Readonly<{ committedResultKey?: string; terminalBranchKeys: readonly string[] }>;

export function evaluateJoin(join: JoinNode, state: JoinState, branch: WorkflowStepResult) {
  if (state.committedResultKey) return { state, cancelKeys: [] as string[] };
  const terminalBranchKeys = [...state.terminalBranchKeys, branch.stepOccurrenceId];
  const accepted = join.acceptedResultKeys.includes(branch.key);
  if (join.policy === "ANY" && accepted) return { state: { committedResultKey: branch.key, terminalBranchKeys }, transition: { targetKey: branch.key }, cancelKeys: join.remainderPolicy === "CANCEL_REMAINDER" ? join.branchKeys.filter((key) => !terminalBranchKeys.includes(key)) : [] };
  if (join.policy === "ALL" && terminalBranchKeys.length === join.branchKeys.length) return { state: { committedResultKey: "ALL", terminalBranchKeys }, transition: { targetKey: "ALL" }, cancelKeys: [] };
  if (join.policy === "ANY" && terminalBranchKeys.length === join.branchKeys.length) return { state: { committedResultKey: "FALLBACK", terminalBranchKeys }, transition: { targetKey: join.fallbackTargetKey }, cancelKeys: [] };
  return { state: { terminalBranchKeys }, cancelKeys: [] };
}
```

- [ ] **Step 4: Run GREEN**

Run: `bun test tests/unit/workflows/joins.test.ts tests/integration/workflows/parallel-review.test.ts && bun run typecheck && bun run lint`

Expected: PASS for keyed `ALL`, `ANY`, fallback, `CANCEL_REMAINDER`, `LET_FINISH`, duplicate, and racing results.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/workflow-results.ts src/server/modules/workflows/parallel-groups.ts src/server/modules/workflows/results.ts src/server/modules/workflows/joins.ts tests/unit/workflows/joins.test.ts tests/integration/workflows/parallel-review.test.ts
git commit -m "feat(automation): add typed parallel joins"
```

### Task 8: Durable Human Decisions With No Parked Process (`AUT-007`)

**Files:**
- Modify: `src/server/db/migrations/0013_workflow_execution.sql`
- Create: `src/server/modules/workflows/human-decisions.ts`
- Create: `src/web/features/workflows/decision-panel.tsx`
- Test: `tests/integration/workflows/human-decision.test.ts`
- Test: `tests/drills/workflow-no-parked-process.test.ts`

**Interfaces:**
- Consumes: `WorkflowEngine.decide`, `ExecutionAuthority.query` for active attempts.
- Produces: immutable `WorkflowDecision` and one idempotent next transition.

- [ ] **Step 1: Write the failing no-parked-process drill**

```ts
test("waiting for a decision has no active process and survives restart", async () => {
  await driveToDecision(engine);
  expect((await authority.query({ kind: "LIST_ACTIVE_ATTEMPTS", workflowExecutionId })).value).toEqual([]);
  const restarted = createWorkflowEngine(database, authority);
  await restarted.decide(decisionCommand("APPROVE"));
  expect(authority.commands.filter((item) => item.kind === "LAUNCH_RUN" && item.workflow?.stepOccurrenceId === "implement-1")).toHaveLength(1);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/integration/workflows/human-decision.test.ts tests/drills/workflow-no-parked-process.test.ts`

Expected: FAIL because decisions are not durable.

- [ ] **Step 3: Add immutable decisions and implementation**

```sql
CREATE TABLE workflow_decisions (
  id TEXT PRIMARY KEY,
  workflow_execution_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  choice TEXT NOT NULL,
  actor_member_id TEXT NOT NULL,
  expected_workflow_revision INTEGER NOT NULL,
  decided_at TEXT NOT NULL,
  UNIQUE (workflow_execution_id, node_key)
) STRICT;
```

```ts
export async function recordDecision(command: RecordHumanDecision, transaction: WorkflowTransaction) {
  const execution = transaction.requireRevision(command.workflowExecutionId, command.expectedRevision);
  if (execution.state !== "WAITING") return err("WORKFLOW_NOT_WAITING", "REFRESH");
  const node = transaction.requireHumanDecisionNode(execution, command.nodeKey);
  if (!node.choices.includes(command.choice)) return err("WORKFLOW_DECISION_INVALID", "NEVER");
  transaction.insertDecision(command);
  transaction.commitTransition(node.key, command.choice);
  return transaction.view(execution.id);
}
```

- [ ] **Step 4: Run GREEN**

Run: `bun test tests/integration/workflows/human-decision.test.ts tests/drills/workflow-no-parked-process.test.ts && bun run typecheck && bun run lint`

Expected: PASS; duplicate decisions do not launch twice and no process remains active while waiting.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/migrations/0013_workflow_execution.sql src/server/modules/workflows/human-decisions.ts src/web/features/workflows/decision-panel.tsx tests/integration/workflows/human-decision.test.ts tests/drills/workflow-no-parked-process.test.ts
git commit -m "feat(automation): persist human workflow decisions"
```

### Task 9: Typed Conditional Fix Routing (`AUT-008`)

**Files:**
- Create: `src/server/modules/workflows/conditions.ts`
- Test: `tests/unit/workflows/conditions.test.ts`
- Test: `tests/integration/workflows/conditional-fix.test.ts`

**Interfaces:**
- Consumes: validated `WorkflowStepResult` from Task 7.
- Produces: `routeTypedResult(router, result)` with no prose fallback.

- [ ] **Step 1: Write the failing major/clean/missing-result test**

```ts
test.each([
  ["MAJOR_FINDING", "fix"],
  ["CLEAN", "terminal"],
  ["MINOR_ONLY", "terminal"],
  ["RESULT_CONTRACT_VIOLATION", "human-review"],
])("routes %s to %s", (key, expected) => {
  expect(routeTypedResult(reviewRouter, { ...baseResult, key }).targetKey).toBe(expected);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/workflows/conditions.test.ts tests/integration/workflows/conditional-fix.test.ts`

Expected: FAIL with missing `routeTypedResult`.

- [ ] **Step 3: Implement exact-key routing**

```ts
export function routeTypedResult(router: ResultRouterNode, result: WorkflowStepResult) {
  const targetKey = router.routes[result.key] ?? router.fallbackTargetKey;
  if (!targetKey) throw new Error("WORKFLOW_RESULT_FALLBACK_REQUIRED");
  return { sourceStepOccurrenceId: result.stepOccurrenceId, resultKey: result.key, targetKey };
}
```

- [ ] **Step 4: Add the architecture assertion and run GREEN**

Run: `if rg -n 'stdout|stderr|transcript|prompt|exitCode|commentBody' src/server/modules/workflows; then exit 1; fi; bun test tests/unit/workflows/conditions.test.ts tests/integration/workflows/conditional-fix.test.ts && bun run typecheck && bun run lint`

Expected: the search exits without matches; tests PASS and exactly one Fix run is created for `MAJOR_FINDING`.

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/workflows/conditions.ts tests/unit/workflows/conditions.test.ts tests/integration/workflows/conditional-fix.test.ts
git commit -m "feat(automation): route typed review results"
```

### Task 10: Trusted-Base Gate Manifests and Exact Fingerprints (`AUT-009`)

**Files:**
- Create: `src/server/db/migrations/0014_gates_telemetry.sql`
- Create: `src/server/db/migrations/0014_gates_telemetry.verify.ts`
- Modify: `src/server/db/migrate.ts`
- Create: `src/shared/contracts/gates.ts`
- Create: `src/server/modules/gates/{contract,manifest,fingerprints,evaluations}.ts`
- Create: `src/runner/gates/{manifest-loader,local-evaluator}.ts`
- Test: `tests/unit/gates/fingerprint.test.ts`
- Test: `tests/integration/gates/evaluations.test.ts`
- Test: `tests/runner/gates/local-evaluator.test.ts`

**Interfaces:**
- Consumes: `ExecutionAuthority.execute(AUTHORIZE_OPERATION)` and `GitHubPort.observeChecks`.
- Produces:

```ts
export interface GateCoordinator {
  inspectManifest(query: InspectGateManifest): Promise<Result<GateManifestSummary>>;
  approveFingerprint(command: ApproveGateFingerprint): Promise<Result<ApprovedGateManifest>>;
  evaluate(command: EvaluateGate): Promise<Result<GateEvaluation>>;
}
```

- [ ] **Step 1: Write the failing self-modification and wrong-SHA tests**

```ts
test("rejects a manifest from the mutating worktree", async () => {
  expect(await gates.evaluate({ ...command, manifestSource: "RUN_WORKTREE" })).toMatchObject({ ok: false, error: { code: "GATE_MANIFEST_UNTRUSTED" } });
});

test("an old SHA check is stale", async () => {
  expect(await gates.evaluate({ ...command, repositoryRevision: newHead, checkObservation: { ...passing, commitSha: oldHead } })).toMatchObject({ ok: false, error: { code: "GATE_REVISION_STALE" } });
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/gates/fingerprint.test.ts tests/integration/gates/evaluations.test.ts tests/runner/gates/local-evaluator.test.ts`

Expected: FAIL with missing gate modules.

- [ ] **Step 3: Add gate persistence and closed contracts**

```sql
CREATE TABLE approved_gate_manifests (
  project_id TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  approved_by_runner_owner_id TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (project_id, base_revision, fingerprint)
) STRICT;

CREATE TABLE gate_evaluations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  repository_revision TEXT NOT NULL,
  gate_key TEXT NOT NULL,
  manifest_fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('LOCAL_COMMAND','GITHUB_CHECK')),
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','PASSED','FAILED','CANCELLED','TIMED_OUT','STALE')),
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
```

```ts
export type ProjectGate =
  | Readonly<{ key: string; kind: "LOCAL_COMMAND"; executable: string; arguments: readonly string[]; timeoutMs: number }>
  | Readonly<{ key: string; kind: "GITHUB_CHECK"; checkName: string }>;

export type GateEvaluation = Readonly<{ id: string; runId: string; repositoryRevision: string; gateKey: string; manifestFingerprint: string; state: "PENDING" | "RUNNING" | "PASSED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "STALE" }>;
```

- [ ] **Step 4: Enforce local no-shell execution and authority**

```ts
export async function evaluateLocalGate(gate: Extract<ProjectGate, { kind: "LOCAL_COMMAND" }>, context: LocalGateContext) {
  if (context.manifestRevision !== context.trustedBaseRevision) return err("GATE_MANIFEST_UNTRUSTED", "NEVER");
  if (context.approvedFingerprint !== context.observedFingerprint) return err("GATE_FINGERPRINT_STALE", "EXPLICIT_RESUME");
  const authorization = await context.authority.execute({ kind: "AUTHORIZE_OPERATION", idempotencyKey: context.idempotencyKey, actor: context.runnerActor, sessionId: context.sessionId, sessionFence: context.sessionFence, operation: { kind: "EXECUTE_LOCAL_GATE", gateEvaluationId: context.evaluationId, repositoryRevision: context.repositoryRevision, manifestFingerprint: context.observedFingerprint } });
  if (!authorization.ok) return authorization;
  return context.spawn([gate.executable, ...gate.arguments], { cwd: context.opaqueWorktreeId, timeoutMs: gate.timeoutMs, shell: false });
}
```

- [ ] **Step 5: Run GREEN and migration verifier**

Run: `bun test tests/unit/gates/fingerprint.test.ts tests/integration/gates/evaluations.test.ts tests/runner/gates/local-evaluator.test.ts src/server/db/migrations/0014_gates_telemetry.verify.ts && bun run typecheck && bun run lint`

Expected: PASS for trusted base and exact SHA; self-modified manifests, transmitted commands, stale fingerprints, tracked mutation, timeout, cancellation, and replay fail.

- [ ] **Step 6: Commit**

```bash
git add src/server/db/migrations/0014_gates_telemetry.sql src/server/db/migrations/0014_gates_telemetry.verify.ts src/server/db/migrate.ts src/shared/contracts/gates.ts src/server/modules/gates src/runner/gates tests/unit/gates tests/integration/gates tests/runner/gates
git commit -m "feat(automation): enforce trusted repository gates"
```

### Task 11: Managed Loops and Three-Valued Stop Policies (`AUT-010`)

**Files:**
- Modify: `src/server/db/migrations/0014_gates_telemetry.sql`
- Create: `src/shared/contracts/stop-policies.ts`
- Create: `src/server/modules/workflows/{managed-loops,stop-policy}.ts`
- Test: `tests/unit/workflows/stop-policy.test.ts`
- Test: `tests/integration/workflows/managed-loop.test.ts`

**Interfaces:**
- Consumes: fresh source facts and `ExecutionAuthority.execute(AUTHORIZE_ATTEMPT)`.
- Produces: `evaluateStopPolicy` and durable consecutive-match state.

- [ ] **Step 1: Write the failing UNKNOWN and budget tests**

```ts
test("UNKNOWN neither increments nor resets consecutive matches", () => {
  expect(evaluateStopPolicy(consecutivePolicy, unknownFacts, { matches: 2 })).toEqual({ result: "UNKNOWN", state: { matches: 2 } });
});

test("failed starts and lost attempts consume the same maximum", async () => {
  await loop.accept(failedToStart);
  await loop.accept(lostAttempt);
  expect(await loop.next()).toMatchObject({ ok: false, error: { code: "ATTEMPT_BUDGET_EXHAUSTED" } });
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/workflows/stop-policy.test.ts tests/integration/workflows/managed-loop.test.ts`

Expected: FAIL with missing Stop Policy implementation.

- [ ] **Step 3: Add closed policy types and evaluator**

```ts
export type PredicateResult = "TRUE" | "FALSE" | "UNKNOWN";
export type StopPolicy =
  | Readonly<{ kind: "ALL"; conditions: readonly StopPolicy[] }>
  | Readonly<{ kind: "ANY"; conditions: readonly StopPolicy[] }>
  | Readonly<{ kind: "NOT"; condition: StopPolicy }>
  | Readonly<{ kind: "SOURCE"; predicate: SourcePredicate }>
  | Readonly<{ kind: "AGENT_OUTCOME"; value: "CONTINUE" | "GOAL_ACHIEVED" | "ESCALATE" }>
  | Readonly<{ kind: "CONSECUTIVE_MATCHES"; condition: StopPolicy; count: number }>;

export function and(results: readonly PredicateResult[]): PredicateResult {
  if (results.includes("FALSE")) return "FALSE";
  return results.includes("UNKNOWN") ? "UNKNOWN" : "TRUE";
}

export function or(results: readonly PredicateResult[]): PredicateResult {
  if (results.includes("TRUE")) return "TRUE";
  return results.includes("UNKNOWN") ? "UNKNOWN" : "FALSE";
}
```

- [ ] **Step 4: Persist counters and authorize every iteration freshly**

```sql
CREATE TABLE managed_loop_state (
  run_id TEXT PRIMARY KEY,
  stop_policy_json TEXT NOT NULL,
  consecutive_state_json TEXT NOT NULL,
  attempts_created INTEGER NOT NULL CHECK (attempts_created >= 0),
  maximum_attempts INTEGER NOT NULL CHECK (maximum_attempts > 0),
  absolute_deadline_at TEXT NOT NULL,
  next_evaluation_at TEXT
) STRICT;
```

```ts
return authority.execute({ kind: "AUTHORIZE_ATTEMPT", idempotencyKey, actor: schedulerActor, runId, expectedRunRevision, cause: { kind: "MANAGED_LOOP", iteration: attemptsCreated + 1 }, execution });
```

- [ ] **Step 5: Run GREEN**

Run: `bun test tests/unit/workflows/stop-policy.test.ts tests/integration/workflows/managed-loop.test.ts && bun run typecheck && bun run lint`

Expected: PASS for TRUE/FALSE/UNKNOWN, consecutive matches, achieved outcome, failed start, lost attempt, attempt exhaustion, and deadline exhaustion.

- [ ] **Step 6: Commit**

```bash
git add src/server/db/migrations/0014_gates_telemetry.sql src/shared/contracts/stop-policies.ts src/server/modules/workflows/managed-loops.ts src/server/modules/workflows/stop-policy.ts tests/unit/workflows/stop-policy.test.ts tests/integration/workflows/managed-loop.test.ts
git commit -m "feat(automation): bound managed workflow loops"
```

### Task 12: Continuous Deadlines, Pause, Restart, and Revocation (`AUT-011`)

**Files:**
- Create: `src/server/modules/workflows/deadlines.ts`
- Create: `src/server/modules/workflows/revocation.ts`
- Test: `tests/unit/workflows/deadlines.test.ts`
- Test: `tests/integration/workflows/revocation.test.ts`
- Test: `tests/drills/{workflow-deadline,workflow-restart,workflow-duplicate-events}.test.ts`

**Interfaces:**
- Consumes: immutable `absoluteDeadlineAt`, Foundation revocation events, ordinary run cancellation through `ExecutionAuthority.execute`.
- Produces: `expireWorkflow`, `applyWorkflowRevocation`.

- [ ] **Step 1: Write the failing pause-past-deadline drill**

```ts
test("pause and waiting never extend the absolute deadline", async () => {
  await engine.pause(pauseCommand);
  clock.advance(absoluteDeadlineMs + 1);
  await restartedEngine.tick();
  expect(await engine.inspect(workflowExecutionId)).toMatchObject({ state: "FAILED", reason: "WORKFLOW_DEADLINE_EXCEEDED" });
  expect(authority.commands.filter((item) => item.kind === "LAUNCH_RUN")).toHaveLength(0);
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/workflows/deadlines.test.ts tests/integration/workflows/revocation.test.ts tests/drills/workflow-deadline.test.ts tests/drills/workflow-restart.test.ts tests/drills/workflow-duplicate-events.test.ts`

Expected: FAIL because expiry and revocation do not invalidate future launch intents.

- [ ] **Step 3: Implement atomic expiry and revocation**

```ts
export function expireWorkflow(transaction: WorkflowTransaction, id: string, now: Instant) {
  const execution = transaction.lockExecution(id);
  if (execution.state === "COMPLETED" || execution.state === "FAILED" || execution.state === "CANCELLED") return execution;
  if (now < execution.absoluteDeadlineAt) return execution;
  transaction.invalidateLaunchIntents(id, "WORKFLOW_DEADLINE_EXCEEDED");
  transaction.transition(id, "FAILED", "WORKFLOW_DEADLINE_EXCEEDED");
  transaction.enqueueOrdinaryRunCancellations(id);
  return transaction.view(id);
}

export function applyWorkflowRevocation(transaction: WorkflowTransaction, event: AuthorityRevocationEvent) {
  transaction.invalidateAffectedLaunchIntents(event);
  transaction.moveRequiredAffectedWorkflowsToWaiting(event, "WORKFLOW_AUTHORITY_REVOKED");
  transaction.retainUnaffectedActiveWork();
}
```

- [ ] **Step 4: Run GREEN**

Run: `bun test tests/unit/workflows/deadlines.test.ts tests/integration/workflows/revocation.test.ts tests/drills/workflow-deadline.test.ts tests/drills/workflow-restart.test.ts tests/drills/workflow-duplicate-events.test.ts && bun run typecheck && bun run lint`

Expected: PASS; pause, waiting, restart, member/exposure/grant revocation, and duplicate events never reset a deadline or launch an unauthorized attempt.

- [ ] **Step 5: Commit**

```bash
git add src/server/modules/workflows/deadlines.ts src/server/modules/workflows/revocation.ts tests/unit/workflows/deadlines.test.ts tests/integration/workflows/revocation.test.ts tests/drills/workflow-deadline.test.ts tests/drills/workflow-restart.test.ts tests/drills/workflow-duplicate-events.test.ts
git commit -m "feat(automation): preserve deadlines through revocation"
```

### Task 13: Portable Planning Workflows (`AUT-012`)

**Files:**
- Create: `src/shared/contracts/plan-artifacts.ts`
- Create: `src/server/modules/workflows/planning.ts`
- Create: `src/web/features/workflows/plan-artifact.tsx`
- Test: `tests/unit/workflows/plan-artifact.test.ts`
- Test: `tests/integration/workflows/planning.test.ts`
- Test: `tests/e2e/planning-workflow.spec.ts`

**Interfaces:**
- Consumes: `INSPECT_ONLY` Agent Run result and optional authorized document reference.
- Produces: `PlanArtifactSchema`, `acceptPlanArtifact`.

- [ ] **Step 1: Write the failing portability test**

```ts
test("Plan Artifacts contain no runtime plan mode or hidden process state", () => {
  const artifact = PlanArtifactSchema.parse(validPlan);
  expect(artifact).toEqual(validPlan);
  expect(JSON.stringify(artifact)).not.toContain("planMode");
  expect(JSON.stringify(artifact)).not.toContain("sessionId");
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/workflows/plan-artifact.test.ts tests/integration/workflows/planning.test.ts`

Expected: FAIL with missing Plan Artifact schema.

- [ ] **Step 3: Implement the bounded schema**

```ts
export type PlanArtifact = Readonly<{
  approach: string;
  assumptions: readonly string[];
  risks: readonly string[];
  affectedAreas: readonly string[];
  verificationStrategy: readonly string[];
  evidence: readonly Readonly<{ kind: "REFERENCE" | "AUTHORED_EXCERPT"; reference: string; revision?: string }>[];
}>;

export const PlanArtifactSchema = z.object({
  approach: z.string().min(1).max(4_000),
  assumptions: z.array(z.string().min(1).max(500)).max(32),
  risks: z.array(z.string().min(1).max(500)).max(32),
  affectedAreas: z.array(z.string().min(1).max(300)).max(64),
  verificationStrategy: z.array(z.string().min(1).max(500)).max(32),
  evidence: z.array(z.object({ kind: z.enum(["REFERENCE", "AUTHORED_EXCERPT"]), reference: z.string().min(1).max(1_000), revision: z.string().max(200).optional() })).max(32),
}).strict();
```

- [ ] **Step 4: Run GREEN including cross-runtime browser flow**

Run: `bun test tests/unit/workflows/plan-artifact.test.ts tests/integration/workflows/planning.test.ts && bun run test:e2e:run -- planning-workflow.spec.ts && bun run typecheck && bun run lint`

Expected: PASS; one runtime plans, a durable approval accepts/rejects, and a distinct runtime/runner/host/mode implements without process-memory dependency.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts/plan-artifacts.ts src/server/modules/workflows/planning.ts src/web/features/workflows/plan-artifact.tsx tests/unit/workflows/plan-artifact.test.ts tests/integration/workflows/planning.test.ts tests/e2e/planning-workflow.spec.ts
git commit -m "feat(automation): add portable planning artifacts"
```

### Task 14: Partial Workflow Usage Telemetry (`AUT-013`)

**Files:**
- Modify: `src/server/db/migrations/0014_gates_telemetry.sql`
- Create: `src/server/modules/telemetry/workflow-usage.ts`
- Test: `tests/unit/workflows/usage.test.ts`
- Test: `tests/integration/workflows/usage.test.ts`

**Interfaces:**
- Consumes: immutable attempt telemetry and Gate Evaluation durations.
- Produces: `aggregateWorkflowUsage`.

- [ ] **Step 1: Write the failing partial-coverage test**

```ts
test("labels partial totals and separates gate time", () => {
  expect(aggregateWorkflowUsage([
    { inputUnits: 100, outputUnits: 20, runtimeMs: 1_000 },
    { inputUnits: "UNKNOWN", outputUnits: "UNKNOWN", runtimeMs: 2_000 },
  ], [{ durationMs: 400 }])).toEqual({
    coverage: { knownAttempts: 1, totalAttempts: 2, status: "PARTIAL" },
    known: { inputUnits: 100, outputUnits: 20 },
    runtimeMs: 3_000,
    gateMs: 400,
  });
});
```

- [ ] **Step 2: Run RED**

Run: `bun test tests/unit/workflows/usage.test.ts tests/integration/workflows/usage.test.ts`

Expected: FAIL with missing aggregation module.

- [ ] **Step 3: Implement compatible-only aggregation**

```ts
export function aggregateWorkflowUsage(attempts: readonly AttemptUsage[], gates: readonly GateUsage[]) {
  const known = attempts.filter((item): item is KnownAttemptUsage => item.inputUnits !== "UNKNOWN" && item.outputUnits !== "UNKNOWN");
  return {
    coverage: { knownAttempts: known.length, totalAttempts: attempts.length, status: known.length === attempts.length ? "COMPLETE" as const : "PARTIAL" as const },
    known: { inputUnits: known.reduce((sum, item) => sum + item.inputUnits, 0), outputUnits: known.reduce((sum, item) => sum + item.outputUnits, 0) },
    runtimeMs: attempts.reduce((sum, item) => sum + item.runtimeMs, 0),
    gateMs: gates.reduce((sum, item) => sum + item.durationMs, 0),
  };
}
```

- [ ] **Step 4: Run GREEN**

Run: `bun test tests/unit/workflows/usage.test.ts tests/integration/workflows/usage.test.ts && bun run typecheck && bun run lint`

Expected: PASS; unknown is never zero, incompatible provider categories are not merged, and no cost estimate is produced.

- [ ] **Step 5: Commit**

```bash
git add src/server/db/migrations/0014_gates_telemetry.sql src/server/modules/telemetry/workflow-usage.ts tests/unit/workflows/usage.test.ts tests/integration/workflows/usage.test.ts
git commit -m "feat(automation): aggregate partial workflow usage"
```

### Task 15: Canonical React Flow Journey and Strict Local/Live Evidence Ledger (`AUT-014`)

**Files:**
- Create: `src/web/features/workflows/execution.tsx`
- Create: `tests/e2e/bounded-automation.spec.ts`
- Create: `docs/evidence/bounded-automation/AUTOMATION-EVIDENCE-LEDGER.md`

**Interfaces:**
- Consumes: Tasks 1–14, Foundation `ExecutionAuthority`, GitHub exact-SHA observation, live disposable repository, live Claude/Codex runner profiles.
- Produces: local canonical journey evidence and a ledger that cannot conflate local and live proof.

- [ ] **Step 1: Write the failing local canonical E2E journey**

```ts
test("authors and executes Implementation -> parallel reviews -> conditional Fix -> Terminal", async ({ page }) => {
  await page.goto("/workflows/new");
  await authorCanonicalWorkflow(page);
  await expect(page.getByRole("status", { name: "Workflow valid" })).toBeVisible();
  await page.getByRole("button", { name: "Publish version" }).click();
  await bindCanonicalProfiles(page, { implementation: "claude-impl", claudeReview: "claude-review", codexReview: "codex-review", fix: "claude-fix" });
  await page.getByRole("button", { name: "Start workflow" }).click();
  await expect(page.getByTestId("workflow-terminal")).toHaveText("COMPLETED");
  await expect(page.getByTestId("fix-run-count")).toHaveText("1");
});
```

- [ ] **Step 2: Run RED**

Run: `bun run test:e2e:run -- bounded-automation.spec.ts`

Expected: FAIL because the execution projection and canonical fixture journey are not wired end to end.

- [ ] **Step 3: Add the execution projection**

```tsx
export function WorkflowExecutionView({ execution, definition }: { execution: WorkflowExecutionViewModel; definition: WorkflowDefinition }) {
  return <section aria-labelledby="workflow-title">
    <h1 id="workflow-title">{execution.name}</h1>
    <ol>{definition.nodes.map((node) => <li key={node.key} data-state={execution.nodes[node.key]?.state ?? "PENDING"}><button type="button" aria-label={`Open ${node.key}`}>{node.key}</button></li>)}</ol>
    {execution.state === "COMPLETED" || execution.state === "FAILED" || execution.state === "CANCELLED" ? <output data-testid="workflow-terminal">{execution.state}</output> : null}
  </section>;
}
```

- [ ] **Step 4: Create the evidence ledger with explicit status rules**

```markdown
# Bounded Automation Evidence Ledger

| Requirement | Proof class | Status | Required evidence |
|---|---|---|---|
| AUT-001..AUT-013 | LOCAL | NOT_RUN | Exact command, build ID, test output path, sanitized audit IDs |
| AUT-014 local safety paths | LOCAL | NOT_RUN | React Flow authoring, clean and major paths, restart, duplicate, deadline, no parked process |
| AUT-014 canonical dogfood | LIVE | BLOCKED | Disposable PR URL, exact head SHA, Claude and Codex run IDs, template/preset/workflow IDs, gate/result IDs, sanitized audit IDs |

`LOCAL` proof never changes a `LIVE` row to `PASS`. A row becomes `PASS` only after the named command or live journey ran against the recorded build and its evidence was reviewed.
```

- [ ] **Step 5: Run the complete local Automation bar**

Run: `bun test tests/unit/templates tests/unit/workflows tests/unit/gates tests/integration/templates tests/integration/workflows tests/integration/gates tests/protocol tests/runner/gates tests/drills/workflow-*.test.ts && bun run test:e2e:run -- workflow-authoring.spec.ts planning-workflow.spec.ts bounded-automation.spec.ts`

Expected: PASS. Record the exact build ID and commands in the LOCAL ledger rows; leave LIVE rows `BLOCKED`.

- [ ] **Step 6: Run the repository package bar**

Run: `bun ci && bun run format:check && bun run lint && bun run typecheck && bun run test && bun run build && bunx playwright install chromium && bun run test:e2e:run && bun run audit:public && bun run manifest:verify && SESSION_SECRET=0123456789abcdef0123456789abcdef PUBLIC_BASE_URL=https://collab.test WEBAUTHN_RP_ID=collab.test DEPLOYMENT_MASTER_KEY_FILE=.env.example BOOTSTRAP_SECRET_FILE=.env.example BACKUP_DIR=/backups docker compose config --quiet && docker build --tag 2collab:verify .`

Expected: every command exits 0. Record environment failures separately and do not mark an unrun check passed.

- [ ] **Step 7: Execute the live disposable-resource gate only with explicit authority**

Run: `bun run test:e2e:run -- bounded-automation.spec.ts --grep "LIVE canonical real PR"`

Expected: with approved disposable GitHub resources and live Claude/Codex credentials, both clean and major-finding paths PASS on the recorded exact PR SHA; without those resources the test reports `BLOCKED`, not `PASS` or `SKIPPED` evidence.

- [ ] **Step 8: Commit**

```bash
git add src/web/features/workflows/execution.tsx tests/e2e/bounded-automation.spec.ts docs/evidence/bounded-automation/AUTOMATION-EVIDENCE-LEDGER.md
git commit -m "test(automation): prove bounded workflow journey"
```

## Final Self-Review Checklist

- [ ] `AUT-001` maps to Task 1; `AUT-002` to Task 2; `AUT-003` to Task 3; authoring completeness to Task 4; `AUT-004` to Task 5; `AUT-005` to Task 6; `AUT-006` to Task 7; `AUT-007` to Task 8; `AUT-008` to Task 9; `AUT-009` to Task 10; `AUT-010` to Task 11; `AUT-011` to Task 12; `AUT-012` to Task 13; `AUT-013` to Task 14; `AUT-014` to Task 15.
- [ ] Every workflow Agent Run launch and continuation uses `ExecutionAuthority.execute`; no Automation module creates permits, sessions, connector authority, worktrees, or mutation overrides.
- [ ] The seven node kinds are exactly `START`, `AGENT_RUN`, `HUMAN_DECISION`, `RESULT_ROUTER`, `PARALLEL_SPLIT`, `JOIN`, and `TERMINAL`.
- [ ] `WorkflowDefinition` and `CanvasLayout` have independent schemas, revisions, and hashes; the server never accepts React Flow objects as executable truth.
- [ ] Draft revision conflicts, duplicate events, restart, pause, waiting, revocation, deadlines, and no-parked-process behavior have executable tests.
- [ ] Gate commands originate only in the trusted-base manifest, use argument arrays without a shell, require owner-approved fingerprints, and bind exact repository revisions.
- [ ] Three-valued Stop Policy logic preserves `UNKNOWN`, every created Attempt consumes the immutable bound, and no deadline can be disabled or extended.
- [ ] Workflow telemetry labels partial coverage, preserves provider categories, separates gate time, and never estimates currency cost.
- [ ] No task persists prohibited raw content or exposes provider errors, secrets, commands, environments, private bindings, or absolute paths.
- [ ] The evidence ledger leaves all unexecuted provider-backed requirements `BLOCKED` or `NOT_RUN`; local mocks never satisfy live proof.
- [ ] Run `rg -n 'TO''DO|TB''D|FIX''ME' docs/superpowers/plans/2026-07-11-automation-implementation.md`; expected: no matches.
- [ ] Run `git diff --check -- docs/superpowers/plans/2026-07-11-automation-implementation.md`; expected: exit 0.
