import { z } from "zod";

export const WorkflowStepResultSchema = z
  .object({
    stepOccurrenceId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    artifacts: z
      .array(
        z
          .object({
            kind: z.string().min(1).max(64),
            reference: z.string().min(1).max(1_000),
            revision: z.string().min(1).max(256),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

export type WorkflowStepResult = Readonly<{
  stepOccurrenceId: string;
  runId: string;
  key: string;
  artifacts: readonly Readonly<{ kind: string; reference: string; revision: string }>[];
}>;

export type JoinState = Readonly<{
  committedResultKey?: string;
  terminalBranchKeys: readonly string[];
  resultsByBranch?: Readonly<Record<string, WorkflowStepResult>>;
}>;
