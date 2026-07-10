# Phase 4: Bounded Automation Implementation Plan

> **Authority: Derived implementation guidance.** The canonical product authority is the [Product Spec](../product/PRODUCT-SPEC.md). If this plan conflicts with it, the Product Spec wins and implementation pauses until this plan is corrected.

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Automation must compose ordinary phase interfaces and may not create a privileged execution or connector path.

**Goal:** Prove workflow complexity earns its cost through typed, bounded, restart-safe implementation/review/fix automation over a real pull request with no parked processes or inferred prose control flow.

**Phase requirements:** `AUT-001` through `AUT-014`.

## Entry gate

- Foundation and GitHub coordination phases pass completely.
- Real source-free and GitHub-backed Agent Runs, exact authority, checkpoints, worktrees, Published Git References, GitHub checks, diff evidence, and canonical Coordination Records are stable.
- React Flow is present only as an editor; no canvas object is accepted by the execution module.

## Stable automation interfaces

Use the master-plan `WorkflowEngine` plus:

```ts
// src/server/modules/templates/contract.ts
export interface TemplateRegistry {
  publishRunTemplate(command: PublishRunTemplate): Promise<Result<TeamRunTemplateVersion>>;
  publishWorkflowTemplate(command: PublishWorkflowTemplate): Promise<Result<TeamWorkflowTemplateVersion>>;
  bind(command: BindWorkflowPreset): Promise<Result<PersonalWorkflowPreset>>;
}

// src/server/modules/gates/contract.ts
export interface GateCoordinator {
  inspectManifest(query: InspectGateManifest): Promise<Result<GateManifestSummary>>;
  approveFingerprint(command: ApproveGateFingerprint): Promise<Result<ApprovedGateManifest>>;
  evaluate(command: EvaluateGate): Promise<Result<GateEvaluation>>;
}

// src/shared/contracts/workflow.ts
export type WorkflowNode =
  | RunStepNode
  | ParallelInspectNode
  | JoinNode
  | HumanDecisionNode
  | ConditionNode
  | TerminalNode;
export type WorkflowDefinition = Readonly<{
  nodes: readonly WorkflowNode[];
  transitions: readonly WorkflowTransition[];
  absoluteDeadlineMs: number;
}>;
```

The `CanvasLayout` contract contains positions, viewport, and collapsed groups only and is versioned independently. Workflow transitions consume typed `WorkflowStepResult` values, never logs, transcripts, terminal text, or exit code alone.

## Task Group 1: Standalone Team Run Templates and immutable configuration

**Requirements:** `AUT-001`; owns `ORP-08`.

**Files:**

- Create `src/server/db/migrations/0301_workflows.sql` and verifier.
- Create `src/shared/contracts/{templates,workflow}.ts`.
- Create `src/server/modules/templates/{contract,run-templates,versioning,bindings}.ts`.
- Create `src/server/adapters/http/routes/templates.ts` and MCP tools `src/server/adapters/mcp/template-tools.ts`.
- Create `src/web/features/templates/`.
- Test `tests/unit/templates/`, `tests/integration/templates/run-templates.test.ts`, `tests/protocol/template-surface-parity.test.ts`.

**Test-first sequence:**

- [ ] Test typed variables, immutable core instructions, bounded personal addendum, Context Recipe, authority ceiling, gates by name, and absence of runner-local commands/credentials.
- [ ] Bind one version to two Personal Run Presets; update template and prove existing run snapshots do not change.
- [ ] Test web/CLI/MCP semantic parity for inspect, publish, and bind.
- [ ] Run narrow suites; expect PASS.

## Task Group 2: Canonical Workflow Definition, layout, editor, and validation

**Requirements:** `AUT-002`, `AUT-003`.

**Files:**

- Create `src/server/modules/workflows/{contract,definition,validation,versioning}.ts`.
- Create `src/server/adapters/http/routes/workflows.ts`.
- Create `src/web/features/workflow-studio/{editor,definition-adapter,validation-panel}.tsx`.
- Test `tests/unit/workflows/{definition,validation,layout}.test.ts`, `tests/e2e/workflow-authoring.spec.ts`.

**Test-first sequence:**

- [ ] Build fixture tests for one valid canonical graph and invalid missing-terminal, missing-fix, unbounded-cycle, unsafe-join, incompatible-result, unreachable-node, and parallel-mutator graphs.
- [ ] Implement pure validation with stable path-addressed diagnostics.
- [ ] Prove layout-only edits do not change semantic hash/version and semantic edits do.
- [ ] Adapt React Flow nodes/edges to canonical schema at the UI seam; server rejects raw React Flow objects.
- [ ] Run unit and authoring E2E suites; expect PASS.

**Failure drill:** Tamper browser payload to add executable fields, change semantic edges without expected version, and publish an invalid graph. All fail before activation.

## Task Group 3: Workflow presets, durable engine, and idempotent scheduling

**Requirements:** `AUT-004`, `AUT-005`.

**Files:**

- Create `src/server/db/migrations/0302_workflow_execution.sql` and verifier.
- Create `src/server/modules/templates/workflow-presets.ts`.
- Create `src/server/modules/workflows/{workflow-engine,scheduler,idempotency,deadlines}.ts`.
- Create `src/server/modules/workflows/step-run-factory.ts`.
- Test `tests/unit/workflows/deadlines.test.ts`, `tests/integration/workflows/{bindings,execution,idempotency,restart}.test.ts`.

**Test-first sequence:**

- [ ] Test every run step requires a compatible explicit Personal Run Preset version; stale/missing bindings return `PRESET_BINDING_REQUIRED` without substitution.
- [ ] Test one immutable Workflow Execution snapshot, one Coordination Record, and one idempotent child Agent Run per activated step.
- [ ] Stop after durable transition but before dispatch, restart, and replay duplicate events; exactly one child run appears.
- [ ] Use a fake clock to prove the absolute deadline never changes across active, paused, waiting, restart, or child-run state.
- [ ] Run narrow suites; expect PASS.

## Task Group 4: Parallel inspection, typed joins, decisions, and conditional fixes

**Requirements:** `AUT-006`, `AUT-007`, `AUT-008`.

**Files:**

- Create `src/server/modules/workflows/{parallel-groups,results,joins,human-decisions,conditions}.ts`.
- Create `src/shared/contracts/workflow-results.ts`.
- Create `src/web/features/workflows/{execution,decision-panel}.tsx`.
- Test `tests/unit/workflows/{joins,conditions}.test.ts`, `tests/integration/workflows/{parallel-review,human-decision,conditional-fix}.test.ts`.

**Test-first sequence:**

- [ ] Test parallel group rejects any `MUTATING` run and gives each inspect-only child independent runner/worktree configuration.
- [ ] Test result schema validation, keyed `ALL`/`ANY`, `CANCEL_REMAINDER`/`LET_FINISH`, and explicit fallback for missing result.
- [ ] Test major finding launches one Fix, while clean/minor-only reaches terminal without Fix.
- [ ] Reach a human decision with no live process, restart, then approve/reject and observe one correct transition.
- [ ] Search implementation for log/transcript parsing imports in the workflow module; architecture test rejects them.
- [ ] Run narrow suites; expect PASS.

## Task Group 5: Portable Planning Workflows

**Requirements:** `AUT-012`; owns `ORP-06`.

**Files:**

- Create `src/shared/contracts/plan-artifacts.ts`.
- Create `src/server/modules/workflows/planning.ts`.
- Create `src/web/features/workflows/plan-artifact.tsx`.
- Test `tests/unit/workflows/plan-artifact.test.ts`, `tests/integration/workflows/planning.test.ts`, `tests/e2e/planning-workflow.spec.ts`.

**Test-first sequence:**

- [ ] Define bounded typed Plan Artifact fields: approach, assumptions, risks, affected areas, verification strategy, authored evidence/reference.
- [ ] Test planning step is `INSPECT_ONLY`, may use any compatible runtime/profile, and produces no hidden process-memory dependency.
- [ ] Test optional durable approval and implementation with a different runtime/runner/host/mode.
- [ ] Assert shared workflow schema contains no runtime-specific `planMode` field.
- [ ] Run narrow suites; expect PASS.

## Task Group 6: Repository gates, Managed Loops, revocation, and telemetry

**Requirements:** `AUT-009`, `AUT-010`, `AUT-011`, `AUT-013`; owns automation half of `ORP-05` and `ORP-14`.

**Files:**

- Create `src/server/db/migrations/0303_gates_telemetry.sql` and verifier.
- Create `src/shared/contracts/{gates,stop-policies}.ts`.
- Create `src/server/modules/gates/{contract,manifest,fingerprints,evaluations}.ts`.
- Create `src/runner/gates/{manifest-loader,local-evaluator}.ts`.
- Create `src/server/modules/workflows/{managed-loops,stop-policy}.ts`.
- Create `src/server/modules/telemetry/workflow-usage.ts`.
- Test `tests/unit/gates/`, `tests/unit/workflows/stop-policy.test.ts`, `tests/integration/gates/`, `tests/integration/workflows/{managed-loop,revocation,usage}.test.ts`.

**Test-first sequence:**

- [ ] Test `.collab/gates.toml` loads only from pinned trusted base revision and templates request semantic Gate Set names only.
- [ ] Test runner-owner fingerprint approval and rejection of self-modified manifest, transmitted command, stale fingerprint/revision, tracked mutation, timeout, and cancellation.
- [ ] Property-test typed stop trees, positive attempt bound, absolute deadline, consecutive matches, unknown source input, and every created-attempt count.
- [ ] Test failed start, lost attempt, waiting, pause, restart, member/exposure/grant revocation, and deadline exhaustion without implicit resume or deadline extension.
- [ ] Test workflow usage aggregation labels partial coverage and keeps gate time separate.
- [ ] Run narrow suites; expect PASS.

**Security drill:** Have a mutating run modify its own gate manifest/tests, revoke runner exposure mid-loop, replay gate result for another SHA, and pause across deadline. Verification never weakens and no new attempt starts.

## Task Group 7: Canonical real-PR dogfood

**Requirements:** `AUT-014`.

**Files:**

- Create `tests/e2e/bounded-automation.spec.ts`.
- Create `tests/drills/workflow-restart.test.ts`, `workflow-duplicate-events.test.ts`, `workflow-deadline.test.ts`, `workflow-no-parked-process.test.ts`.

**Test-first sequence:**

- [ ] Author or materially edit the exact workflow through React Flow and publish the canonical schema version.
- [ ] Bind Implementation, Claude review, Codex review, conditional Fix, and Terminal with explicit distinct runtime/model choices.
- [ ] Execute on a real disposable pull request and capture template/preset/workflow/run/revision/gate/result IDs.
- [ ] Exercise both clean and major-finding paths, missing-result fallback, missing terminal/fix validation, restart, duplicate events, pause/wait deadline, and human decision with no parked process.
- [ ] Attach sanitized evidence to `docs/evidence/bounded-automation/<build-id>.md`.

## Verification commands

```bash
bun run format:check && bun run lint && bun run typecheck
bun test tests/unit/templates tests/unit/workflows tests/unit/gates tests/integration/templates tests/integration/workflows tests/integration/gates
bun test tests/drills/workflow-*.test.ts
bun run build && bun run test:e2e -- workflow-authoring.spec.ts planning-workflow.spec.ts bounded-automation.spec.ts
```

Expected: all exit 0. Repeat canonical dogfood against a real disposable pull request using live Claude and Codex attempts.

## Canonical Product Spec exit criterion

> Exit when the team dogfoods **Implementation -> parallel Claude and Codex review -> conditional Fix -> Terminal** on a real pull request with different runtimes or models per step; validation catches missing terminal and fix paths; restart and duplicate events create no duplicate run; pause and waiting do not extend the deadline; and no process remains parked for a human decision.

## Phase exit gate

- `AUT-001` through `AUT-014` are `PASS`.
- The canonical criterion above is retained unchanged in evidence.
- Standalone Team Run Templates and Portable Planning Workflows have independent proofs.
- Exact-SHA GitHub observation remains a connector concern; manifest/fingerprint/Gate Set orchestration is proven here.
- No workflow code parses runtime prose or creates execution/connector authority outside existing interfaces.

## Rollback boundary

Disable workflow publication and scheduling, revoke active workflow scheduling leases, cancel or checkpoint child Agent Runs through ordinary authority paths, and retain immutable execution history. Restore the authenticated pre-migration backup only for schema rollback; do not delete external pull requests, comments, checks, or Outline documents to imitate rollback.
