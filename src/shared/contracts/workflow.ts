import { z } from "zod";

const KeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_-]*$/);
const ResultKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const VariableSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    type: z.enum(["STRING", "NUMBER", "BOOLEAN"]),
    required: z.boolean(),
  })
  .strict();

export const WORKFLOW_NODE_KINDS = [
  "START",
  "AGENT_RUN",
  "HUMAN_DECISION",
  "RESULT_ROUTER",
  "PARALLEL_SPLIT",
  "JOIN",
  "TERMINAL",
] as const;

const StartNodeSchema = z.object({ kind: z.literal("START"), key: KeySchema }).strict();
const AgentRunNodeSchema = z
  .object({
    kind: z.literal("AGENT_RUN"),
    key: KeySchema,
    runTemplateVersionId: z.string().min(1).max(128),
    resultKeys: z.array(ResultKeySchema).min(1).max(32),
  })
  .strict();
const HumanDecisionNodeSchema = z
  .object({
    kind: z.literal("HUMAN_DECISION"),
    key: KeySchema,
    choices: z.array(ResultKeySchema).min(1).max(16),
  })
  .strict();
const ResultRouterNodeSchema = z
  .object({
    kind: z.literal("RESULT_ROUTER"),
    key: KeySchema,
    sourceStepKey: KeySchema,
    routes: z.record(ResultKeySchema, KeySchema),
    fallbackTargetKey: KeySchema,
  })
  .strict();
const ParallelSplitNodeSchema = z
  .object({
    kind: z.literal("PARALLEL_SPLIT"),
    key: KeySchema,
    branchKeys: z.array(KeySchema).min(2).max(64),
  })
  .strict();
const JoinNodeSchema = z
  .object({
    kind: z.literal("JOIN"),
    key: KeySchema,
    branchKeys: z.array(KeySchema).min(2).max(64),
    policy: z.enum(["ALL", "ANY"]),
    acceptedResultKeys: z.array(ResultKeySchema).min(1).max(32),
    fallbackTargetKey: KeySchema,
    remainderPolicy: z.enum(["CANCEL_REMAINDER", "LET_FINISH"]).optional(),
  })
  .strict();
const TerminalNodeSchema = z
  .object({
    kind: z.literal("TERMINAL"),
    key: KeySchema,
    outcome: z.enum(["COMPLETED", "FAILED", "CANCELLED"]),
  })
  .strict();

export const WorkflowNodeSchema = z.discriminatedUnion("kind", [
  StartNodeSchema,
  AgentRunNodeSchema,
  HumanDecisionNodeSchema,
  ResultRouterNodeSchema,
  ParallelSplitNodeSchema,
  JoinNodeSchema,
  TerminalNodeSchema,
]);

export const WorkflowDefinitionSchema = z
  .object({
    inputs: z.array(VariableSchema).max(64),
    nodes: z.array(WorkflowNodeSchema).min(2).max(256),
    transitions: z
      .array(z.object({ from: KeySchema, resultKey: ResultKeySchema, to: KeySchema }).strict())
      .max(512),
    maximumRunCount: z.number().int().positive(),
    cycleBounds: z.record(z.string().min(1).max(512), z.number().int().positive()),
    maximumParallelBranches: z.number().int().positive(),
    maximumConcurrency: z.number().int().positive(),
    absoluteDeadlineMs: z.number().int().positive().finite(),
  })
  .strict();

export const CanvasLayoutSchema = z
  .object({
    nodes: z.array(
      z
        .object({
          key: KeySchema,
          x: z.number().finite(),
          y: z.number().finite(),
          collapsed: z.boolean(),
        })
        .strict(),
    ),
    viewport: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        zoom: z.number().positive().finite(),
      })
      .strict(),
    collapsedGroups: z.array(KeySchema),
  })
  .strict();

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
  | Readonly<{
      kind: "AGENT_RUN";
      key: string;
      runTemplateVersionId: string;
      resultKeys: readonly string[];
    }>
  | Readonly<{ kind: "HUMAN_DECISION"; key: string; choices: readonly string[] }>
  | ResultRouterNode
  | Readonly<{ kind: "PARALLEL_SPLIT"; key: string; branchKeys: readonly string[] }>
  | JoinNode
  | Readonly<{
      kind: "TERMINAL";
      key: string;
      outcome: "COMPLETED" | "FAILED" | "CANCELLED";
    }>;
export type WorkflowDefinition = Readonly<{
  inputs: readonly Readonly<{
    key: string;
    type: "STRING" | "NUMBER" | "BOOLEAN";
    required: boolean;
  }>[];
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

export type WorkflowDraft = Readonly<{
  id: string;
  templateKey: string;
  revision: number;
  definition: WorkflowDefinition;
  layout: CanvasLayout;
  updatedByMemberId: string;
  updatedAt: number;
}>;
