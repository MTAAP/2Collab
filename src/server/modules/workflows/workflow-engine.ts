import type { Database } from "bun:sqlite";
import type { ExecutionAuthority } from "../../../shared/contracts/execution-authority.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { WorkflowDefinitionSchema, type WorkflowNode } from "../../../shared/contracts/workflow.ts";
import type { JoinState, WorkflowStepResult } from "../../../shared/contracts/workflow-results.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";
import { stableJson } from "../templates/run-templates.ts";
import { routeTypedResult } from "./conditions.ts";
import type {
  RecordHumanDecision,
  StartWorkflow,
  StepLaunchConfiguration,
  WorkflowEngine,
  WorkflowEventCommand,
  WorkflowExecution,
  WorkflowControlCommand,
  WorkflowExecutionSnapshot,
  WorkflowExecutionState,
} from "./contract.ts";
import { workflowDigest, workflowIdempotencyKey } from "./idempotency.ts";
import { evaluateJoin } from "./joins.ts";
import { validateStepResult } from "./results.ts";
import { dispatchStep, type WorkflowLaunchIntent } from "./step-run-factory.ts";
import { validateWorkflow } from "./validation.ts";
import type { TeamRunTemplateVersion } from "../../../shared/contracts/templates.ts";

type Dependencies = Readonly<{
  database: Database;
  authority: ExecutionAuthority;
  clockMs: () => number;
  allowInlineLaunchesForTesting?: boolean;
  resolveLaunches?: (
    input: Readonly<{
      definition: import("../../../shared/contracts/workflow.ts").WorkflowDefinition;
      inputs: Readonly<Record<string, string | number | boolean>>;
      bindings: Readonly<
        Record<string, Readonly<{ personalRunPresetId: string; expectedVersion: number }>>
      >;
      schedulerActor: import("../../../shared/contracts/actors.ts").SchedulerActor;
    }>,
  ) => Promise<Result<Readonly<Record<string, StepLaunchConfiguration>>>>;
  revocationAffects?: (
    snapshot: WorkflowExecutionSnapshot,
    event: import("./revocation.ts").WorkflowAuthorityRevocationEvent,
  ) => boolean;
}>;
type ExecutionRow = Readonly<{
  id: string;
  coordination_record_id: string;
  coordination_revision: number;
  template_version_id: string;
  preset_version_id: string;
  state: WorkflowExecutionState;
  current_node_key: string | null;
  pending_target_key: string | null;
  snapshot_json: string;
  revision: number;
  absolute_deadline_at: number;
  terminal_reason: string | null;
  created_at: number;
  updated_at: number;
}>;
type OccurrenceRow = Readonly<{
  id: string;
  workflow_execution_id: string;
  node_key: string;
  occurrence: number;
  agent_run_id: string | null;
  state: "PENDING" | "LAUNCH_INTENT" | "RUNNING" | "TERMINAL" | "CANCELLED";
  result_json: string | null;
}>;
type IntentRow = Readonly<{
  idempotency_key: string;
  workflow_execution_id: string;
  step_occurrence_id: string;
  workflow_revision: number;
  command_json: string;
  dispatched_at: number | null;
  invalidated_reason: string | null;
}>;

function failure<T>(
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" | "SAME_INPUT" = "NEVER",
): Result<T> {
  return { ok: false, error: { code, message, retry } };
}
function executionRow(database: Database, id: string): ExecutionRow | null {
  return (
    database
      .query<ExecutionRow, [string]>("SELECT * FROM workflow_executions WHERE id = ?")
      .get(id) ?? null
  );
}
function executionView(row: ExecutionRow): WorkflowExecution {
  return {
    id: row.id,
    coordinationRecordId: row.coordination_record_id as never,
    coordinationRevision: row.coordination_revision,
    templateVersionId: row.template_version_id,
    presetVersionId: row.preset_version_id,
    state: row.state,
    ...(row.current_node_key ? { currentNodeKey: row.current_node_key } : {}),
    revision: row.revision,
    absoluteDeadlineAt: row.absolute_deadline_at,
    ...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function snapshot(row: ExecutionRow): WorkflowExecutionSnapshot {
  return JSON.parse(row.snapshot_json) as WorkflowExecutionSnapshot;
}
function typedInputsValid(
  definition: import("../../../shared/contracts/workflow.ts").WorkflowDefinition,
  inputs: Readonly<Record<string, string | number | boolean>>,
): boolean {
  const declared = new Map(definition.inputs.map((input) => [input.key, input]));
  if (Object.keys(inputs).some((key) => !declared.has(key))) return false;
  return definition.inputs.every((input) => {
    const value = inputs[input.key];
    if (value === undefined) return !input.required;
    return (
      (input.type === "STRING" && typeof value === "string" && value.length <= 16_384) ||
      (input.type === "NUMBER" && typeof value === "number" && Number.isFinite(value)) ||
      (input.type === "BOOLEAN" && typeof value === "boolean")
    );
  });
}
function loadStoredDefinition(
  database: Database,
  templateVersionId: string,
): import("../../../shared/contracts/workflow.ts").WorkflowDefinition | null {
  const row = database
    .query<{ definition_json: string }, [string]>(
      "SELECT definition_json FROM team_workflow_template_versions WHERE id = ?",
    )
    .get(templateVersionId);
  if (!row) return null;
  const parsed = WorkflowDefinitionSchema.safeParse(JSON.parse(row.definition_json));
  return parsed.success ? parsed.data : null;
}
function loadRunTemplates(
  database: Database,
  definition: import("../../../shared/contracts/workflow.ts").WorkflowDefinition,
): ReadonlyMap<string, TeamRunTemplateVersion> {
  const result = new Map<string, TeamRunTemplateVersion>();
  for (const node of definition.nodes) {
    if (node.kind !== "AGENT_RUN" || result.has(node.runTemplateVersionId)) continue;
    const row = database
      .query<
        {
          id: string;
          template_key: string;
          version: number;
          definition_json: string;
          semantic_hash: string;
        },
        [string]
      >(
        `SELECT id, template_key, version, definition_json, semantic_hash
         FROM team_run_template_versions WHERE id = ? AND archived_at IS NULL`,
      )
      .get(node.runTemplateVersionId);
    if (row)
      result.set(row.id, {
        id: row.id,
        templateKey: row.template_key,
        version: row.version,
        definition: JSON.parse(row.definition_json),
        semanticHash: row.semantic_hash,
      } as TeamRunTemplateVersion);
  }
  return result;
}
function nodeByKey(
  snapshotValue: WorkflowExecutionSnapshot,
  key: string,
): WorkflowNode | undefined {
  return snapshotValue.definition.nodes.find((node) => node.key === key);
}
function updateExecution(
  database: Database,
  row: ExecutionRow,
  input: Readonly<{
    state: WorkflowExecutionState;
    currentNodeKey?: string;
    terminalReason?: string;
    pendingTargetKey?: string | null;
    now: number;
    bumpRevision: boolean;
  }>,
): ExecutionRow {
  database
    .query<void, [string, string | null, string | null, string | null, number, number, string]>(
      `UPDATE workflow_executions
       SET state = ?, current_node_key = ?, pending_target_key = ?, terminal_reason = ?, revision = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.state,
      input.currentNodeKey ?? null,
      input.pendingTargetKey === undefined ? row.pending_target_key : input.pendingTargetKey,
      input.terminalReason ?? null,
      row.revision + (input.bumpRevision ? 1 : 0),
      input.now,
      row.id,
    );
  return executionRow(database, row.id) as ExecutionRow;
}
function scheduleAgent(
  database: Database,
  row: ExecutionRow,
  snapshotValue: WorkflowExecutionSnapshot,
  nodeKey: string,
): void {
  const configuration = snapshotValue.launches[nodeKey];
  if (!configuration) throw new Error("WORKFLOW_STEP_BINDING_REQUIRED");
  const total = database
    .query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM workflow_step_occurrences WHERE workflow_execution_id = ?",
    )
    .get(row.id)?.count;
  if ((total ?? 0) >= snapshotValue.definition.maximumRunCount)
    throw new Error("WORKFLOW_RUN_BOUND_EXCEEDED");
  const occurrence =
    (database
      .query<{ count: number }, [string, string]>(
        "SELECT count(*) AS count FROM workflow_step_occurrences WHERE workflow_execution_id = ? AND node_key = ?",
      )
      .get(row.id, nodeKey)?.count ?? 0) + 1;
  const stepOccurrenceId = `${nodeKey}-${occurrence}`;
  const idempotencyKey = workflowIdempotencyKey(row.id, stepOccurrenceId);
  database
    .query<void, [string, string, string, number]>(
      `INSERT INTO workflow_step_occurrences(
         id, workflow_execution_id, node_key, occurrence, state
       ) VALUES (?, ?, ?, ?, 'LAUNCH_INTENT')`,
    )
    .run(stepOccurrenceId, row.id, nodeKey, occurrence);
  database
    .query<void, [string, string, string, number, string]>(
      `INSERT INTO workflow_launch_intents(
         idempotency_key, workflow_execution_id, step_occurrence_id, workflow_revision, command_json
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(idempotencyKey, row.id, stepOccurrenceId, row.revision, stableJson(configuration));
}
function enqueueActiveChildCancellations(database: Database, workflowExecutionId: string): void {
  const active = database
    .query<{ id: string; agent_run_id: string }, [string]>(
      `SELECT id, agent_run_id FROM workflow_step_occurrences
       WHERE workflow_execution_id = ? AND state = 'RUNNING' AND agent_run_id IS NOT NULL`,
    )
    .all(workflowExecutionId);
  for (const child of active)
    database
      .query<void, [string, string, string, string]>(
        `INSERT OR IGNORE INTO workflow_cancellation_outbox(
           idempotency_key, workflow_execution_id, step_occurrence_id, agent_run_id
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        `workflow-cancel-${workflowExecutionId}-${child.id}`,
        workflowExecutionId,
        child.id,
        child.agent_run_id,
      );
}
type TraversedEdge = readonly [from: string, to: string];
function recordCycleTraversals(
  database: Database,
  row: ExecutionRow,
  snapshotValue: WorkflowExecutionSnapshot,
  edges: readonly TraversedEdge[],
  now: number,
): boolean {
  let exceeded = false;
  for (const [signature, bound] of Object.entries(snapshotValue.definition.cycleBounds)) {
    const keys = signature.split("->");
    const cycleEdges = keys.map(
      (key, index) => [key, keys[(index + 1) % keys.length] as string] as const,
    );
    for (const [from, to] of edges) {
      if (!cycleEdges.some(([cycleFrom, cycleTo]) => cycleFrom === from && cycleTo === to))
        continue;
      database
        .query<void, [string, string, string, string]>(
          `INSERT INTO workflow_cycle_edge_counters(
             workflow_execution_id, cycle_signature, edge_from, edge_to, traversal_count
           ) VALUES (?, ?, ?, ?, 1)
           ON CONFLICT(workflow_execution_id, cycle_signature, edge_from, edge_to)
           DO UPDATE SET traversal_count = traversal_count + 1`,
        )
        .run(row.id, signature, from, to);
      const closingEdge = cycleEdges.at(-1);
      if (closingEdge?.[0] !== from || closingEdge[1] !== to) continue;
      database
        .query<void, [string, string]>(
          `INSERT INTO workflow_cycle_counters(
             workflow_execution_id, cycle_signature, completed_count
           ) VALUES (?, ?, 1)
           ON CONFLICT(workflow_execution_id, cycle_signature)
           DO UPDATE SET completed_count = completed_count + 1`,
        )
        .run(row.id, signature);
      const completed = database
        .query<{ completed_count: number }, [string, string]>(
          `SELECT completed_count FROM workflow_cycle_counters
           WHERE workflow_execution_id = ? AND cycle_signature = ?`,
        )
        .get(row.id, signature)?.completed_count;
      if ((completed ?? 0) > bound) exceeded = true;
    }
  }
  if (!exceeded) return true;
  database
    .query(
      `UPDATE workflow_launch_intents
       SET invalidated_reason = 'WORKFLOW_CYCLE_BOUND_EXCEEDED'
       WHERE workflow_execution_id = ? AND dispatched_at IS NULL`,
    )
    .run(row.id);
  enqueueActiveChildCancellations(database, row.id);
  updateExecution(database, row, {
    state: "FAILED",
    currentNodeKey: row.current_node_key ?? undefined,
    terminalReason: "WORKFLOW_CYCLE_BOUND_EXCEEDED",
    now,
    bumpRevision: true,
  });
  return false;
}
function applyTarget(
  database: Database,
  row: ExecutionRow,
  snapshotValue: WorkflowExecutionSnapshot,
  targetKey: string,
  now: number,
  bumpRevision: boolean,
): ExecutionRow {
  const target = nodeByKey(snapshotValue, targetKey);
  if (!target)
    return updateExecution(database, row, {
      state: "WAITING",
      currentNodeKey: targetKey,
      terminalReason: "WORKFLOW_TARGET_UNAVAILABLE",
      now,
      bumpRevision,
    });
  if (target.kind === "TERMINAL")
    return updateExecution(database, row, {
      state: target.outcome,
      currentNodeKey: target.key,
      terminalReason: target.outcome,
      now,
      bumpRevision,
    });
  if (target.kind === "HUMAN_DECISION")
    return updateExecution(database, row, {
      state: "WAITING",
      currentNodeKey: target.key,
      now,
      bumpRevision,
    });
  if (target.kind === "AGENT_RUN") {
    scheduleAgent(database, row, snapshotValue, target.key);
    return updateExecution(database, row, {
      state: "ACTIVE",
      currentNodeKey: target.key,
      now,
      bumpRevision,
    });
  }
  if (target.kind === "PARALLEL_SPLIT") {
    for (const branchKey of target.branchKeys) {
      const branch = nodeByKey(snapshotValue, branchKey);
      const configuration = snapshotValue.launches[branchKey];
      if (branch?.kind !== "AGENT_RUN" || configuration?.repository.mode !== "INSPECT_ONLY")
        throw new Error("WORKFLOW_PARALLEL_MUTATION_FORBIDDEN");
      scheduleAgent(database, row, snapshotValue, branchKey);
    }
    return updateExecution(database, row, {
      state: "ACTIVE",
      currentNodeKey: target.key,
      now,
      bumpRevision,
    });
  }
  return updateExecution(database, row, {
    state: "WAITING",
    currentNodeKey: target.key,
    terminalReason: "WORKFLOW_TRANSITION_REQUIRED",
    now,
    bumpRevision,
  });
}

export function createWorkflowEngine(dependencies: Dependencies): WorkflowEngine {
  const clockMs = dependencies.clockMs;
  let crashBeforeDispatch = false;
  const inspect = (workflowExecutionId: string): Result<WorkflowExecution> => {
    const row = executionRow(dependencies.database, workflowExecutionId);
    return row
      ? { ok: true, value: executionView(row) }
      : failure("WORKFLOW_NOT_FOUND", "The Workflow Execution was not found.");
  };
  const control = (
    command: WorkflowControlCommand,
    action: "PAUSE" | "RESUME" | "CANCEL",
  ): Result<WorkflowExecution> => {
    const requestDigest = workflowDigest({ ...command, action });
    const prior = dependencies.database
      .query<{ request_digest: string; result_json: string }, [string]>(
        "SELECT request_digest, result_json FROM workflow_control_receipts WHERE idempotency_key = ?",
      )
      .get(command.idempotencyKey);
    if (prior)
      return prior.request_digest === requestDigest
        ? (JSON.parse(prior.result_json) as Result<WorkflowExecution>)
        : failure("IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used.");
    return inImmediateTransaction(dependencies.database, () => {
      let row = executionRow(dependencies.database, command.workflowExecutionId);
      if (!row) return failure("WORKFLOW_NOT_FOUND", "The Workflow Execution was not found.");
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(row.state))
        return failure("WORKFLOW_TERMINAL", "The Workflow Execution is terminal.");
      if (row.revision !== command.expectedRevision)
        return failure("WORKFLOW_REVISION_CONFLICT", "The Workflow Execution changed.", "REFRESH");
      const snapshotValue = snapshot(row);
      if (snapshotValue.schedulerActor.originalDispatcherId !== command.actor.memberId)
        return failure("WORKFLOW_ACTOR_INVALID", "The workflow control actor is invalid.");
      const now = clockMs();
      if (action === "CANCEL") {
        dependencies.database
          .query(
            "UPDATE workflow_launch_intents SET invalidated_reason = 'WORKFLOW_CANCELLED' WHERE workflow_execution_id = ? AND dispatched_at IS NULL",
          )
          .run(row.id);
        enqueueActiveChildCancellations(dependencies.database, row.id);
        row = updateExecution(dependencies.database, row, {
          state: "CANCELLED",
          currentNodeKey: row.current_node_key ?? undefined,
          terminalReason: "WORKFLOW_CANCELLED",
          now,
          bumpRevision: true,
        });
      } else if (action === "RESUME" && now >= row.absolute_deadline_at) {
        dependencies.database
          .query(
            "UPDATE workflow_launch_intents SET invalidated_reason = 'WORKFLOW_DEADLINE_EXCEEDED' WHERE workflow_execution_id = ? AND dispatched_at IS NULL",
          )
          .run(row.id);
        enqueueActiveChildCancellations(dependencies.database, row.id);
        row = updateExecution(dependencies.database, row, {
          state: "FAILED",
          currentNodeKey: row.current_node_key ?? undefined,
          terminalReason: "WORKFLOW_DEADLINE_EXCEEDED",
          now,
          bumpRevision: true,
        });
      } else {
        const currentNode = row.current_node_key
          ? nodeByKey(snapshotValue, row.current_node_key)
          : undefined;
        const pendingTargetKey = row.pending_target_key;
        row = updateExecution(dependencies.database, row, {
          state:
            action === "PAUSE"
              ? "PAUSED"
              : currentNode?.kind === "HUMAN_DECISION"
                ? "WAITING"
                : "ACTIVE",
          currentNodeKey: row.current_node_key ?? undefined,
          now,
          bumpRevision: true,
        });
        if (action === "RESUME" && pendingTargetKey) {
          row = applyTarget(
            dependencies.database,
            row,
            snapshotValue,
            pendingTargetKey,
            now,
            false,
          );
          dependencies.database
            .query("UPDATE workflow_executions SET pending_target_key = NULL WHERE id = ?")
            .run(row.id);
          row = executionRow(dependencies.database, row.id) as ExecutionRow;
        }
      }
      const result = { ok: true as const, value: executionView(row) };
      dependencies.database
        .query<void, [string, string, string, string, number]>(
          `INSERT INTO workflow_control_receipts(
             idempotency_key, request_digest, workflow_execution_id, result_json, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          command.idempotencyKey,
          requestDigest,
          command.workflowExecutionId,
          JSON.stringify(result),
          now,
        );
      return result;
    });
  };

  return {
    inspect,
    applyRevocation(event) {
      return inImmediateTransaction(dependencies.database, () => {
        const rows = dependencies.database
          .query<ExecutionRow, []>(
            "SELECT * FROM workflow_executions WHERE state IN ('ACTIVE','WAITING','PAUSED')",
          )
          .all();
        const affected: WorkflowExecution[] = [];
        for (const row of rows) {
          const value = snapshot(row);
          const matches =
            (event.kind === "MEMBER" &&
              value.schedulerActor.originalDispatcherId === event.subjectId) ||
            dependencies.revocationAffects?.(value, event) === true;
          if (!matches) continue;
          dependencies.database
            .query(
              `UPDATE workflow_launch_intents
               SET invalidated_reason = 'WORKFLOW_AUTHORITY_REVOKED'
               WHERE workflow_execution_id = ? AND dispatched_at IS NULL`,
            )
            .run(row.id);
          enqueueActiveChildCancellations(dependencies.database, row.id);
          affected.push(
            executionView(
              updateExecution(dependencies.database, row, {
                state: "WAITING",
                currentNodeKey: row.current_node_key ?? undefined,
                terminalReason: "WORKFLOW_AUTHORITY_REVOKED",
                now: clockMs(),
                bumpRevision: true,
              }),
            ),
          );
        }
        return affected;
      });
    },
    async pause(command) {
      return control(command, "PAUSE");
    },
    async resume(command) {
      return control(command, "RESUME");
    },
    async cancel(command) {
      return control(command, "CANCEL");
    },
    failAfterIntentCommitOnce() {
      crashBeforeDispatch = true;
    },
    async start(command: StartWorkflow): Promise<Result<WorkflowExecution>> {
      const requestDigest = workflowDigest(command);
      const prior = dependencies.database
        .query<{ request_digest: string; result_json: string }, [string]>(
          "SELECT request_digest, result_json FROM workflow_start_receipts WHERE idempotency_key = ?",
        )
        .get(command.idempotencyKey);
      if (prior)
        return prior.request_digest === requestDigest
          ? (JSON.parse(prior.result_json) as Result<WorkflowExecution>)
          : failure("IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used.");
      const storedMode = command.definition === undefined || command.launches === undefined;
      if (!storedMode && !dependencies.allowInlineLaunchesForTesting)
        return failure(
          "WORKFLOW_STORED_LAUNCH_REQUIRED",
          "Workflows must launch from stored immutable versions.",
        );
      const storedDefinition = storedMode
        ? loadStoredDefinition(dependencies.database, command.templateVersionId)
        : null;
      const parsedDefinition = WorkflowDefinitionSchema.safeParse(
        storedMode ? storedDefinition : command.definition,
      );
      if (!parsedDefinition.success)
        return failure("WORKFLOW_INVALID", "The Workflow Definition is invalid.");
      const definition = parsedDefinition.data;
      let launches = command.launches;
      let resolvedPresetVersionId = command.presetVersionId;
      let presetBindings:
        | Readonly<
            Record<string, Readonly<{ personalRunPresetId: string; expectedVersion: number }>>
          >
        | undefined;
      let runTemplatesSnapshot: ReadonlyMap<string, TeamRunTemplateVersion> | undefined;
      const inputs = command.inputs ?? {};
      if (storedMode) {
        if (
          !command.workflowPresetId ||
          !Number.isInteger(command.workflowPresetVersion) ||
          !typedInputsValid(definition, inputs)
        )
          return failure("WORKFLOW_INPUT_INVALID", "The typed Workflow inputs are invalid.");
        const preset = dependencies.database
          .query<
            {
              workflow_template_version_id: string;
              bindings_json: string;
              owner_member_id: string;
            },
            [string, number]
          >(
            `SELECT workflow_template_version_id, bindings_json, owner_member_id
             FROM personal_workflow_presets WHERE id = ? AND version = ?`,
          )
          .get(command.workflowPresetId, command.workflowPresetVersion as number);
        if (
          !preset ||
          preset.workflow_template_version_id !== command.templateVersionId ||
          preset.owner_member_id !== command.schedulerActor.originalDispatcherId
        )
          return failure("WORKFLOW_PRESET_STALE", "The Workflow Preset is unavailable.", "REFRESH");
        presetBindings = JSON.parse(preset.bindings_json) as typeof presetBindings;
        resolvedPresetVersionId = `${command.workflowPresetId}_v${command.workflowPresetVersion}`;
        const agentKeys = definition.nodes
          .filter((node) => node.kind === "AGENT_RUN")
          .map((node) => node.key)
          .sort();
        if (
          Object.keys(presetBindings ?? {})
            .sort()
            .join("\0") !== agentKeys.join("\0")
        )
          return failure(
            "WORKFLOW_PRESET_BINDING_REQUIRED",
            "Every Agent Run requires one exact preset binding.",
            "REFRESH",
          );
        const diagnostics = validateWorkflow(
          definition,
          loadRunTemplates(dependencies.database, definition),
        );
        if (diagnostics.length > 0)
          return failure("WORKFLOW_INVALID", "The Workflow Definition is invalid.");
        if (!dependencies.resolveLaunches)
          return failure(
            "WORKFLOW_LAUNCH_RESOLVER_REQUIRED",
            "Workflow launch bindings cannot be resolved.",
            "REFRESH",
          );
        const resolved = await dependencies.resolveLaunches({
          definition,
          inputs,
          bindings: presetBindings ?? {},
          schedulerActor: command.schedulerActor,
        });
        if (!resolved.ok) return resolved;
        launches = resolved.value;
        if (Object.keys(launches).sort().join("\0") !== agentKeys.join("\0"))
          return failure(
            "WORKFLOW_PRESET_BINDING_REQUIRED",
            "Every Agent Run requires one exact preset binding.",
            "REFRESH",
          );
        const templates = loadRunTemplates(dependencies.database, definition);
        runTemplatesSnapshot = templates;
        for (const node of definition.nodes) {
          if (node.kind !== "AGENT_RUN") continue;
          const template = templates.get(node.runTemplateVersionId);
          const launch = launches[node.key];
          if (
            !template ||
            !launch ||
            template.definition.repositoryMode !== launch.repository.mode ||
            (template.definition.minimumAssurance === "ENFORCED" &&
              launch.repository.assurance !== "ENFORCED")
          )
            return failure(
              "WORKFLOW_PRESET_BINDING_INCOMPATIBLE",
              "A Workflow step binding is incompatible with its Run Template.",
              "REFRESH",
            );
        }
      }
      if (command.schedulerActor.workflowExecutionId !== command.workflowExecutionId)
        return failure("WORKFLOW_ACTOR_INVALID", "The workflow scheduler actor is invalid.");
      const start = definition.nodes.find((node) => node.kind === "START");
      const transition = start
        ? definition.transitions.find(
            (candidate) => candidate.from === start.key && candidate.resultKey === "STARTED",
          )
        : undefined;
      if (!start || !transition)
        return failure("WORKFLOW_INVALID", "The Workflow Definition is invalid.");
      try {
        return inImmediateTransaction(dependencies.database, () => {
          const now = clockMs();
          const snapshotValue: WorkflowExecutionSnapshot = {
            definition,
            schedulerActor: command.schedulerActor,
            launches: launches ?? {},
            ...(storedMode ? { inputs, presetBindings } : {}),
          };
          if (storedMode) {
            const currentDefinition = loadStoredDefinition(
              dependencies.database,
              command.templateVersionId,
            );
            const currentPreset = dependencies.database
              .query<
                { bindings_json: string; workflow_template_version_id: string },
                [string, number]
              >(
                `SELECT bindings_json, workflow_template_version_id
                 FROM personal_workflow_presets WHERE id = ? AND version = ?`,
              )
              .get(command.workflowPresetId as string, command.workflowPresetVersion as number);
            if (
              !currentDefinition ||
              stableJson(currentDefinition) !== stableJson(definition) ||
              !currentPreset ||
              currentPreset.workflow_template_version_id !== command.templateVersionId ||
              stableJson(JSON.parse(currentPreset.bindings_json)) !== stableJson(presetBindings) ||
              stableJson([...loadRunTemplates(dependencies.database, definition)]) !==
                stableJson([...(runTemplatesSnapshot ?? [])])
            )
              throw new Error("WORKFLOW_LAUNCH_SNAPSHOT_STALE");
          }
          dependencies.database
            .query<void, [string, string, number, string, string, string, number, number, number]>(
              `INSERT INTO workflow_executions(
                 id, coordination_record_id, coordination_revision, template_version_id,
                 preset_version_id, state, snapshot_json, revision, absolute_deadline_at,
                 created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, 1, ?, ?, ?)`,
            )
            .run(
              command.workflowExecutionId,
              command.coordinationRecordId,
              command.coordinationRevision,
              command.templateVersionId,
              resolvedPresetVersionId,
              stableJson(snapshotValue),
              now + definition.absoluteDeadlineMs,
              now,
              now,
            );
          let row = executionRow(
            dependencies.database,
            command.workflowExecutionId,
          ) as ExecutionRow;
          if (
            recordCycleTraversals(
              dependencies.database,
              row,
              snapshotValue,
              [[start.key, transition.to]],
              now,
            )
          )
            row = applyTarget(dependencies.database, row, snapshotValue, transition.to, now, false);
          else row = executionRow(dependencies.database, row.id) as ExecutionRow;
          const result = { ok: true as const, value: executionView(row) };
          dependencies.database
            .query<void, [string, string, string, string, number]>(
              `INSERT INTO workflow_start_receipts(
                 idempotency_key, request_digest, workflow_execution_id, result_json, created_at
               ) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              command.idempotencyKey,
              requestDigest,
              command.workflowExecutionId,
              JSON.stringify(result),
              now,
            );
          return result;
        });
      } catch (error) {
        return failure(
          error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "WORKFLOW_STORAGE_FAILED",
          "The Workflow Execution could not be started.",
          "SAME_INPUT",
        );
      }
    },
    async tick(): Promise<void> {
      const now = clockMs();
      inImmediateTransaction(dependencies.database, () => {
        const expired = dependencies.database
          .query<ExecutionRow, [number]>(
            `SELECT * FROM workflow_executions
             WHERE state IN ('ACTIVE','WAITING','PAUSED') AND absolute_deadline_at <= ?`,
          )
          .all(now);
        for (const row of expired) {
          dependencies.database
            .query(
              "UPDATE workflow_launch_intents SET invalidated_reason = 'WORKFLOW_DEADLINE_EXCEEDED' WHERE workflow_execution_id = ? AND dispatched_at IS NULL",
            )
            .run(row.id);
          enqueueActiveChildCancellations(dependencies.database, row.id);
          updateExecution(dependencies.database, row, {
            state: "FAILED",
            currentNodeKey: row.current_node_key ?? undefined,
            terminalReason: "WORKFLOW_DEADLINE_EXCEEDED",
            now,
            bumpRevision: true,
          });
        }
      });
      const intents = dependencies.database
        .query<IntentRow, []>(
          `SELECT idempotency_key, workflow_execution_id, step_occurrence_id,
                  workflow_revision, command_json, dispatched_at, invalidated_reason
           FROM workflow_launch_intents
           WHERE dispatched_at IS NULL AND invalidated_reason IS NULL
           ORDER BY rowid`,
        )
        .all();
      if (crashBeforeDispatch && intents.length > 0) {
        crashBeforeDispatch = false;
        throw new Error("INJECTED_WORKFLOW_SCHEDULER_CRASH");
      }
      for (const intentRow of intents) {
        let row = executionRow(dependencies.database, intentRow.workflow_execution_id);
        if (row?.state !== "ACTIVE" || clockMs() >= row.absolute_deadline_at) continue;
        const snapshotValue = snapshot(row);
        if (snapshotValue.presetBindings) {
          if (!dependencies.resolveLaunches) continue;
          const refreshed = await dependencies.resolveLaunches({
            definition: snapshotValue.definition,
            inputs: snapshotValue.inputs ?? {},
            bindings: snapshotValue.presetBindings,
            schedulerActor: snapshotValue.schedulerActor,
          });
          const nodeKey = intentRow.step_occurrence_id.replace(/-\d+$/, "");
          if (
            !refreshed.ok ||
            !refreshed.value[nodeKey] ||
            stableJson(refreshed.value[nodeKey]) !== stableJson(snapshotValue.launches[nodeKey])
          ) {
            const observedRow = row;
            inImmediateTransaction(dependencies.database, () => {
              const current = executionRow(dependencies.database, observedRow.id);
              if (
                !current ||
                current.revision !== observedRow.revision ||
                current.state !== "ACTIVE"
              )
                return;
              dependencies.database
                .query(
                  `UPDATE workflow_launch_intents
                   SET invalidated_reason = 'WORKFLOW_PRESET_BINDING_STALE'
                   WHERE idempotency_key = ? AND dispatched_at IS NULL`,
                )
                .run(intentRow.idempotency_key);
              updateExecution(dependencies.database, current, {
                state: "WAITING",
                currentNodeKey: current.current_node_key ?? undefined,
                terminalReason: "WORKFLOW_PRESET_BINDING_STALE",
                now: clockMs(),
                bumpRevision: true,
              });
            });
            continue;
          }
          row = executionRow(dependencies.database, row.id);
          if (row?.state !== "ACTIVE") continue;
        }
        const activeCount = dependencies.database
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM workflow_step_occurrences WHERE workflow_execution_id = ? AND state = 'RUNNING'",
          )
          .get(row.id)?.count;
        if ((activeCount ?? 0) >= snapshotValue.definition.maximumConcurrency) continue;
        const intent: WorkflowLaunchIntent = {
          idempotencyKey: intentRow.idempotency_key,
          workflowExecutionId: row.id,
          stepOccurrenceId: intentRow.step_occurrence_id,
          workflowRevision: intentRow.workflow_revision,
          configuration: JSON.parse(intentRow.command_json) as StepLaunchConfiguration,
        };
        const launched = await dispatchStep(
          intent,
          executionView(row),
          snapshotValue,
          dependencies.authority,
        );
        if (!launched.ok) continue;
        inImmediateTransaction(dependencies.database, () => {
          const current = executionRow(dependencies.database, row.id);
          const currentIntent = dependencies.database
            .query<IntentRow, [string]>(
              `SELECT idempotency_key, workflow_execution_id, step_occurrence_id,
                      workflow_revision, command_json, dispatched_at, invalidated_reason
               FROM workflow_launch_intents WHERE idempotency_key = ?`,
            )
            .get(intent.idempotencyKey);
          if (!current || !currentIntent || currentIntent.dispatched_at !== null) return;
          const completedAt = clockMs();
          if (
            completedAt >= current.absolute_deadline_at &&
            currentIntent.invalidated_reason === null
          ) {
            dependencies.database
              .query(
                `UPDATE workflow_launch_intents
                 SET invalidated_reason = 'WORKFLOW_DEADLINE_EXCEEDED'
                 WHERE idempotency_key = ? AND invalidated_reason IS NULL`,
              )
              .run(intent.idempotencyKey);
            if (!["COMPLETED", "FAILED", "CANCELLED"].includes(current.state))
              updateExecution(dependencies.database, current, {
                state: "FAILED",
                currentNodeKey: current.current_node_key ?? undefined,
                terminalReason: "WORKFLOW_DEADLINE_EXCEEDED",
                now: completedAt,
                bumpRevision: true,
              });
          }
          const reconciledIntent = dependencies.database
            .query<{ invalidated_reason: string | null }, [string]>(
              "SELECT invalidated_reason FROM workflow_launch_intents WHERE idempotency_key = ?",
            )
            .get(intent.idempotencyKey);
          dependencies.database
            .query<void, [number, string]>(
              "UPDATE workflow_launch_intents SET dispatched_at = ? WHERE idempotency_key = ? AND dispatched_at IS NULL",
            )
            .run(completedAt, intent.idempotencyKey);
          const launchRemainsValid =
            reconciledIntent?.invalidated_reason === null &&
            ["ACTIVE", "PAUSED"].includes(
              (executionRow(dependencies.database, current.id) as ExecutionRow).state,
            );
          dependencies.database
            .query<void, [string, string, string]>(
              `UPDATE workflow_step_occurrences
               SET state = ?, agent_run_id = ?
               WHERE id = ? AND agent_run_id IS NULL`,
            )
            .run(
              launchRemainsValid ? "RUNNING" : "CANCELLED",
              launched.value.run.id,
              intent.stepOccurrenceId,
            );
          if (!launchRemainsValid) {
            dependencies.database
              .query<void, [string, string, string, string]>(
                `INSERT OR IGNORE INTO workflow_cancellation_outbox(
                   idempotency_key, workflow_execution_id, step_occurrence_id, agent_run_id
                 ) VALUES (?, ?, ?, ?)`,
              )
              .run(
                `workflow-cancel-${current.id}-${intent.stepOccurrenceId}`,
                current.id,
                intent.stepOccurrenceId,
                launched.value.run.id,
              );
            const invalidated = executionRow(dependencies.database, current.id) as ExecutionRow;
            dependencies.database
              .query<void, [number, number, number, string]>(
                `UPDATE workflow_executions
                 SET coordination_revision = ?, revision = ?, updated_at = ? WHERE id = ?`,
              )
              .run(
                launched.value.record.revision,
                invalidated.revision + 1,
                completedAt,
                invalidated.id,
              );
            return;
          }
          const latest = executionRow(dependencies.database, current.id) as ExecutionRow;
          dependencies.database
            .query<void, [number, number, number, string]>(
              `UPDATE workflow_executions
               SET coordination_revision = ?, revision = ?, updated_at = ? WHERE id = ?`,
            )
            .run(launched.value.record.revision, latest.revision + 1, completedAt, latest.id);
        });
      }
      const cancellations = dependencies.database
        .query<
          {
            idempotency_key: string;
            workflow_execution_id: string;
            agent_run_id: string;
          },
          []
        >(
          `SELECT idempotency_key, workflow_execution_id, agent_run_id
           FROM workflow_cancellation_outbox WHERE requested_at IS NULL ORDER BY rowid`,
        )
        .all();
      for (const cancellation of cancellations) {
        const row = executionRow(dependencies.database, cancellation.workflow_execution_id);
        if (!row) continue;
        const snapshotValue = snapshot(row);
        const observed = await dependencies.authority.query({
          kind: "INSPECT_RUN",
          actor: snapshotValue.schedulerActor,
          runId: cancellation.agent_run_id as never,
        });
        if (!observed.ok || observed.value.kind !== "INSPECT_RUN") continue;
        if (!["COMPLETED", "FAILED", "CANCELLED"].includes(observed.value.run.state)) {
          const cancelled = await dependencies.authority.execute({
            kind: "CANCEL_RUN",
            idempotencyKey: cancellation.idempotency_key as never,
            actor: snapshotValue.schedulerActor,
            runId: cancellation.agent_run_id as never,
            expectedRunRevision: observed.value.run.revision,
            reason: "WORKFLOW",
          });
          if (!cancelled.ok) continue;
        }
        dependencies.database
          .query(
            "UPDATE workflow_cancellation_outbox SET requested_at = ? WHERE idempotency_key = ?",
          )
          .run(clockMs(), cancellation.idempotency_key);
      }
    },
    async accept(command: WorkflowEventCommand): Promise<Result<WorkflowExecution>> {
      const digest = workflowDigest(command);
      const prior = dependencies.database
        .query<{ event_digest: string; workflow_execution_id: string }, [string]>(
          "SELECT event_digest, workflow_execution_id FROM workflow_event_receipts WHERE event_id = ?",
        )
        .get(command.eventId);
      if (prior)
        return prior.event_digest === digest
          ? inspect(prior.workflow_execution_id)
          : failure("WORKFLOW_EVENT_CONFLICT", "The workflow event identifier was reused.");
      let result: WorkflowStepResult;
      try {
        result = validateStepResult(command.result);
      } catch {
        return failure("WORKFLOW_RESULT_CONTRACT_VIOLATION", "The step result is invalid.");
      }
      const row = executionRow(dependencies.database, command.workflowExecutionId);
      if (!row) return failure("WORKFLOW_NOT_FOUND", "The Workflow Execution was not found.");
      const occurrence = dependencies.database
        .query<OccurrenceRow, [string, string]>(
          "SELECT * FROM workflow_step_occurrences WHERE id = ? AND workflow_execution_id = ?",
        )
        .get(command.stepOccurrenceId, command.workflowExecutionId);
      if (
        occurrence?.state !== "RUNNING" ||
        occurrence.agent_run_id !== command.runId ||
        result.stepOccurrenceId !== occurrence.id ||
        result.runId !== command.runId
      )
        return failure("WORKFLOW_STEP_EVENT_INVALID", "The step event does not match active work.");
      const snapshotValue = snapshot(row);
      if (
        command.actor.originalDispatcherId !== snapshotValue.schedulerActor.originalDispatcherId ||
        command.actor.workflowExecutionId !== snapshotValue.schedulerActor.workflowExecutionId
      )
        return failure("WORKFLOW_ACTOR_INVALID", "The workflow event actor is invalid.");
      if (row.revision !== command.expectedRevision)
        return failure("WORKFLOW_REVISION_CONFLICT", "The Workflow Execution changed.", "REFRESH");
      const step = nodeByKey(snapshotValue, occurrence.node_key);
      if (
        step?.kind !== "AGENT_RUN" ||
        (!step.resultKeys.includes(result.key) &&
          !["RUN_FAILED", "RUN_CANCELLED"].includes(result.key))
      )
        return failure(
          "WORKFLOW_RESULT_CONTRACT_VIOLATION",
          "The step result does not match its versioned contract.",
        );
      const observed = await dependencies.authority.query({
        kind: "INSPECT_RUN",
        actor: snapshotValue.schedulerActor,
        runId: command.runId as never,
      });
      if (
        !observed.ok ||
        observed.value.kind !== "INSPECT_RUN" ||
        !["COMPLETED", "FAILED", "CANCELLED"].includes(observed.value.run.state)
      )
        return failure("WORKFLOW_RUN_NOT_TERMINAL", "The Agent Run is not terminal.", "REFRESH");
      try {
        return inImmediateTransaction(dependencies.database, () => {
          let current = executionRow(dependencies.database, row.id) as ExecutionRow;
          if (["COMPLETED", "FAILED", "CANCELLED"].includes(current.state))
            return { ok: true as const, value: executionView(current) };
          if (current.revision !== command.expectedRevision)
            return failure(
              "WORKFLOW_REVISION_CONFLICT",
              "The Workflow Execution changed.",
              "REFRESH",
            );
          const currentOccurrence = dependencies.database
            .query<OccurrenceRow, [string, string]>(
              "SELECT * FROM workflow_step_occurrences WHERE id = ? AND workflow_execution_id = ?",
            )
            .get(command.stepOccurrenceId, command.workflowExecutionId);
          if (
            currentOccurrence?.state !== "RUNNING" ||
            currentOccurrence.agent_run_id !== command.runId
          )
            return failure(
              "WORKFLOW_STEP_EVENT_INVALID",
              "The step event does not match active work.",
            );
          dependencies.database
            .query<void, [string, string]>(
              "UPDATE workflow_step_occurrences SET state = 'TERMINAL', result_json = ? WHERE id = ?",
            )
            .run(stableJson(result), occurrence.id);
          dependencies.database
            .query<void, [string, string, string, number]>(
              "INSERT INTO workflow_event_receipts(event_id, workflow_execution_id, event_digest, accepted_at) VALUES (?, ?, ?, ?)",
            )
            .run(command.eventId, row.id, digest, clockMs());
          const join = snapshotValue.definition.nodes.find(
            (node) => node.kind === "JOIN" && node.branchKeys.includes(occurrence.node_key),
          );
          let targetKey: string | undefined;
          const traversedEdges: TraversedEdge[] = [];
          if (join?.kind === "JOIN") {
            traversedEdges.push([occurrence.node_key, join.key]);
            const priorJoin = dependencies.database
              .query<{ state_json: string; revision: number }, [string, string]>(
                "SELECT state_json, revision FROM workflow_join_states WHERE workflow_execution_id = ? AND join_node_key = ?",
              )
              .get(row.id, join.key);
            const evaluated = evaluateJoin(
              join,
              priorJoin
                ? (JSON.parse(priorJoin.state_json) as JoinState)
                : { terminalBranchKeys: [] },
              result,
            );
            dependencies.database
              .query<void, [string, string, string, number]>(
                `INSERT INTO workflow_join_states(workflow_execution_id, join_node_key, state_json, revision)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(workflow_execution_id, join_node_key) DO UPDATE SET
                   state_json = excluded.state_json, revision = excluded.revision`,
              )
              .run(row.id, join.key, stableJson(evaluated.state), (priorJoin?.revision ?? 0) + 1);
            for (const cancelKey of evaluated.cancelKeys) {
              dependencies.database
                .query(
                  `UPDATE workflow_launch_intents SET invalidated_reason = 'JOIN_REMAINDER_CANCELLED'
                   WHERE workflow_execution_id = ? AND step_occurrence_id IN (
                     SELECT id FROM workflow_step_occurrences
                     WHERE workflow_execution_id = ? AND node_key = ? AND agent_run_id IS NULL
                   )`,
                )
                .run(row.id, row.id, cancelKey);
              dependencies.database
                .query(
                  `UPDATE workflow_step_occurrences SET state = 'CANCELLED'
                   WHERE workflow_execution_id = ? AND node_key = ? AND agent_run_id IS NULL`,
                )
                .run(row.id, cancelKey);
              const activeRemainders = dependencies.database
                .query<{ id: string; agent_run_id: string }, [string, string]>(
                  `SELECT id, agent_run_id FROM workflow_step_occurrences
                   WHERE workflow_execution_id = ? AND node_key = ?
                     AND state = 'RUNNING' AND agent_run_id IS NOT NULL`,
                )
                .all(row.id, cancelKey);
              for (const remainder of activeRemainders)
                dependencies.database
                  .query<void, [string, string, string, string]>(
                    `INSERT OR IGNORE INTO workflow_cancellation_outbox(
                       idempotency_key, workflow_execution_id, step_occurrence_id, agent_run_id
                     ) VALUES (?, ?, ?, ?)`,
                  )
                  .run(
                    `workflow-cancel-${row.id}-${remainder.id}`,
                    row.id,
                    remainder.id,
                    remainder.agent_run_id,
                  );
            }
            if (evaluated.transition) {
              const transition = snapshotValue.definition.transitions.find(
                (item) =>
                  item.from === join.key && item.resultKey === evaluated.transition?.targetKey,
              );
              targetKey = transition?.to ?? evaluated.transition.targetKey;
              traversedEdges.push([join.key, targetKey]);
            }
          } else {
            const transition = snapshotValue.definition.transitions.find(
              (item) => item.from === step.key && item.resultKey === result.key,
            );
            if (transition) {
              const target = nodeByKey(snapshotValue, transition.to);
              if (target?.kind === "RESULT_ROUTER") {
                targetKey = routeTypedResult(target, result).targetKey;
                traversedEdges.push([step.key, target.key], [target.key, targetKey]);
              } else {
                targetKey = transition.to;
                traversedEdges.push([step.key, targetKey]);
              }
            }
          }
          if (
            !recordCycleTraversals(
              dependencies.database,
              current,
              snapshotValue,
              traversedEdges,
              clockMs(),
            )
          ) {
            current = executionRow(dependencies.database, current.id) as ExecutionRow;
            return { ok: true as const, value: executionView(current) };
          }
          current = targetKey
            ? current.state === "PAUSED"
              ? updateExecution(dependencies.database, current, {
                  state: "PAUSED",
                  currentNodeKey: occurrence.node_key,
                  pendingTargetKey: targetKey,
                  now: clockMs(),
                  bumpRevision: true,
                })
              : applyTarget(
                  dependencies.database,
                  current,
                  snapshotValue,
                  targetKey,
                  clockMs(),
                  true,
                )
            : updateExecution(dependencies.database, current, {
                state: "WAITING",
                currentNodeKey: occurrence.node_key,
                terminalReason: "WORKFLOW_TRANSITION_REQUIRED",
                now: clockMs(),
                bumpRevision: true,
              });
          return { ok: true as const, value: executionView(current) };
        });
      } catch {
        return failure("WORKFLOW_STORAGE_FAILED", "The workflow event could not be committed.");
      }
    },
    async decide(command: RecordHumanDecision): Promise<Result<WorkflowExecution>> {
      const prior = dependencies.database
        .query<
          { id: string; workflow_execution_id: string; choice: string; actor_member_id: string },
          [string, string]
        >(
          "SELECT id, workflow_execution_id, choice, actor_member_id FROM workflow_decisions WHERE workflow_execution_id = ? AND node_key = ?",
        )
        .get(command.workflowExecutionId, command.nodeKey);
      if (prior)
        return prior.id === command.decisionId &&
          prior.choice === command.choice &&
          prior.actor_member_id === command.actor.memberId
          ? inspect(prior.workflow_execution_id)
          : failure("WORKFLOW_DECISION_CONFLICT", "The workflow decision was already recorded.");
      try {
        return inImmediateTransaction(dependencies.database, () => {
          let row = executionRow(dependencies.database, command.workflowExecutionId);
          if (!row) return failure("WORKFLOW_NOT_FOUND", "The Workflow Execution was not found.");
          if (row.revision !== command.expectedRevision)
            return failure(
              "WORKFLOW_REVISION_CONFLICT",
              "The Workflow Execution changed.",
              "REFRESH",
            );
          if (row.state !== "WAITING" || row.current_node_key !== command.nodeKey)
            return failure(
              "WORKFLOW_NOT_WAITING",
              "The Workflow Execution is not waiting.",
              "REFRESH",
            );
          const snapshotValue = snapshot(row);
          const node = nodeByKey(snapshotValue, command.nodeKey);
          if (node?.kind !== "HUMAN_DECISION" || !node.choices.includes(command.choice))
            return failure("WORKFLOW_DECISION_INVALID", "The workflow decision is invalid.");
          const membersTable = dependencies.database
            .query<{ present: number }, []>(
              "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='members'",
            )
            .get();
          if (membersTable) {
            const member = dependencies.database
              .query<{ role: "OWNER" | "MEMBER"; status: string }, [string]>(
                "SELECT role, status FROM members WHERE id = ?",
              )
              .get(command.actor.memberId);
            if (
              member?.status !== "ACTIVE" ||
              (node.requiredRole === "OWNER" && member.role !== "OWNER")
            )
              return failure(
                "WORKFLOW_DECISION_ACTOR_DENIED",
                "The member cannot record this workflow decision.",
              );
          }
          dependencies.database
            .query<void, [string, string, string, string, string, number, number]>(
              `INSERT INTO workflow_decisions(
                 id, workflow_execution_id, node_key, choice, actor_member_id,
                 expected_workflow_revision, decided_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              command.decisionId,
              command.workflowExecutionId,
              command.nodeKey,
              command.choice,
              command.actor.memberId,
              command.expectedRevision,
              clockMs(),
            );
          const transition = snapshotValue.definition.transitions.find(
            (item) => item.from === node.key && item.resultKey === command.choice,
          );
          const withinCycleBound =
            !transition ||
            recordCycleTraversals(
              dependencies.database,
              row,
              snapshotValue,
              [[node.key, transition.to]],
              clockMs(),
            );
          row = !withinCycleBound
            ? (executionRow(dependencies.database, row.id) as ExecutionRow)
            : transition
              ? applyTarget(
                  dependencies.database,
                  row,
                  snapshotValue,
                  transition.to,
                  clockMs(),
                  true,
                )
              : updateExecution(dependencies.database, row, {
                  state: "WAITING",
                  currentNodeKey: node.key,
                  terminalReason: "WORKFLOW_TRANSITION_REQUIRED",
                  now: clockMs(),
                  bumpRevision: true,
                });
          return { ok: true as const, value: executionView(row) };
        });
      } catch {
        return failure("WORKFLOW_STORAGE_FAILED", "The workflow decision could not be committed.");
      }
    },
  };
}
