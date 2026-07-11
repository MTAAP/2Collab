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
  WorkflowExecutionSnapshot,
  WorkflowExecutionState,
} from "./contract.ts";
import { workflowDigest, workflowIdempotencyKey } from "./idempotency.ts";
import { evaluateJoin } from "./joins.ts";
import { validateStepResult } from "./results.ts";
import { dispatchStep, type WorkflowLaunchIntent } from "./step-run-factory.ts";

type Dependencies = Readonly<{
  database: Database;
  authority: ExecutionAuthority;
  clock: () => number;
}>;
type ExecutionRow = Readonly<{
  id: string;
  coordination_record_id: string;
  coordination_revision: number;
  template_version_id: string;
  preset_version_id: string;
  state: WorkflowExecutionState;
  current_node_key: string | null;
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
    now: number;
    bumpRevision: boolean;
  }>,
): ExecutionRow {
  database
    .query<void, [string, string | null, string | null, number, number, string]>(
      `UPDATE workflow_executions
       SET state = ?, current_node_key = ?, terminal_reason = ?, revision = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.state,
      input.currentNodeKey ?? null,
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
  let crashBeforeDispatch = false;
  const inspect = (workflowExecutionId: string): Result<WorkflowExecution> => {
    const row = executionRow(dependencies.database, workflowExecutionId);
    return row
      ? { ok: true, value: executionView(row) }
      : failure("WORKFLOW_NOT_FOUND", "The Workflow Execution was not found.");
  };

  return {
    inspect,
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
      const parsedDefinition = WorkflowDefinitionSchema.safeParse(command.definition);
      if (!parsedDefinition.success)
        return failure("WORKFLOW_INVALID", "The Workflow Definition is invalid.");
      const definition = parsedDefinition.data;
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
          const now = dependencies.clock();
          const snapshotValue: WorkflowExecutionSnapshot = {
            definition,
            schedulerActor: command.schedulerActor,
            launches: command.launches,
          };
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
              command.presetVersionId,
              stableJson(snapshotValue),
              now + definition.absoluteDeadlineMs,
              now,
              now,
            );
          let row = executionRow(
            dependencies.database,
            command.workflowExecutionId,
          ) as ExecutionRow;
          row = applyTarget(dependencies.database, row, snapshotValue, transition.to, now, false);
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
      const now = dependencies.clock();
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
                  workflow_revision, command_json
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
        const row = executionRow(dependencies.database, intentRow.workflow_execution_id);
        if (row?.state !== "ACTIVE" || dependencies.clock() >= row.absolute_deadline_at) continue;
        const snapshotValue = snapshot(row);
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
          if (current?.state !== "ACTIVE") return;
          dependencies.database
            .query<void, [number, string]>(
              "UPDATE workflow_launch_intents SET dispatched_at = ? WHERE idempotency_key = ? AND dispatched_at IS NULL",
            )
            .run(dependencies.clock(), intent.idempotencyKey);
          dependencies.database
            .query<void, [string, string]>(
              "UPDATE workflow_step_occurrences SET state = 'RUNNING', agent_run_id = ? WHERE id = ?",
            )
            .run(launched.value.run.id, intent.stepOccurrenceId);
          dependencies.database
            .query<void, [number, number, number, string]>(
              `UPDATE workflow_executions
               SET coordination_revision = ?, revision = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              launched.value.record.revision,
              current.revision + 1,
              dependencies.clock(),
              current.id,
            );
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
          .run(dependencies.clock(), cancellation.idempotency_key);
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
          dependencies.database
            .query<void, [string, string]>(
              "UPDATE workflow_step_occurrences SET state = 'TERMINAL', result_json = ? WHERE id = ?",
            )
            .run(stableJson(result), occurrence.id);
          dependencies.database
            .query<void, [string, string, string, number]>(
              "INSERT INTO workflow_event_receipts(event_id, workflow_execution_id, event_digest, accepted_at) VALUES (?, ?, ?, ?)",
            )
            .run(command.eventId, row.id, digest, dependencies.clock());
          const join = snapshotValue.definition.nodes.find(
            (node) => node.kind === "JOIN" && node.branchKeys.includes(occurrence.node_key),
          );
          let targetKey: string | undefined;
          if (join?.kind === "JOIN") {
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
            }
          } else {
            const transition = snapshotValue.definition.transitions.find(
              (item) => item.from === step.key && item.resultKey === result.key,
            );
            if (transition) {
              const target = nodeByKey(snapshotValue, transition.to);
              targetKey =
                target?.kind === "RESULT_ROUTER"
                  ? routeTypedResult(target, result).targetKey
                  : transition.to;
            }
          }
          current = targetKey
            ? applyTarget(
                dependencies.database,
                current,
                snapshotValue,
                targetKey,
                dependencies.clock(),
                true,
              )
            : updateExecution(dependencies.database, current, {
                state: "WAITING",
                currentNodeKey: occurrence.node_key,
                terminalReason: "WORKFLOW_TRANSITION_REQUIRED",
                now: dependencies.clock(),
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
              dependencies.clock(),
            );
          const transition = snapshotValue.definition.transitions.find(
            (item) => item.from === node.key && item.resultKey === command.choice,
          );
          row = transition
            ? applyTarget(
                dependencies.database,
                row,
                snapshotValue,
                transition.to,
                dependencies.clock(),
                true,
              )
            : updateExecution(dependencies.database, row, {
                state: "WAITING",
                currentNodeKey: node.key,
                terminalReason: "WORKFLOW_TRANSITION_REQUIRED",
                now: dependencies.clock(),
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
