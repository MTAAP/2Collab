import type { Result } from "../../../shared/contracts/result.ts";
import { type DurableCheckpoint, DurableCheckpointSchema } from "../../../shared/contracts/runs.ts";

export type CheckpointInput = Readonly<{
  id: string;
  runId: string;
  attemptId: string;
  reason: DurableCheckpoint["reason"];
  requestedAction: DurableCheckpoint["requestedAction"];
  summary: string;
  runnerId: string;
  worktreeIdentity: string;
  currentCommit?: string;
  recoverableRemoteReference?: Readonly<{
    remoteIdentity: string;
    remoteRef: string;
    commitSha: string;
    verifiedAt: number;
  }>;
  evidenceIds: readonly string[];
  sourceRevisions: Readonly<Record<string, string>>;
  resumeGuidance: string;
  createdAt: number;
}>;

export function createCheckpoint(input: CheckpointInput): Result<DurableCheckpoint> {
  const parsed = DurableCheckpointSchema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data as unknown as DurableCheckpoint }
    : {
        ok: false,
        error: {
          code: "CHECKPOINT_INVALID",
          message: "Checkpoint facts are invalid.",
          retry: "NEVER",
        },
      };
}
