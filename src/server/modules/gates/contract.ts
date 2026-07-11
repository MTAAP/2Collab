import type { RunnerActor } from "../../../shared/contracts/actors.ts";
import type { GitHubCheckObservation } from "../../../shared/contracts/github.ts";
import type {
  GateEvaluation,
  GateManifestSummary,
  LocalGateEvidence,
} from "../../../shared/contracts/gates.ts";
import type { Result } from "../../../shared/contracts/result.ts";

export type InspectGateManifest = Readonly<{
  source: string;
  manifestRevision: string;
  trustedBaseRevision: string;
}>;
export type ApproveGateFingerprint = Readonly<{
  runnerId: string;
  projectId: string;
  baseRevision: string;
  fingerprint: string;
  approvedByRunnerOwnerId: string;
  approvedAt: number;
}>;
export type EvaluateGate = Readonly<{
  id: string;
  projectId: string;
  baseRevision: string;
  runId: string;
  repositoryRevision: string;
  gateKey: string;
  manifestFingerprint: string;
  kind: "LOCAL_COMMAND" | "GITHUB_CHECK";
  manifestSource: "TRUSTED_BASE" | "RUN_WORKTREE";
  runnerActor?: RunnerActor;
  sessionId?: string;
  sessionFence?: number;
  idempotencyKey?: string;
  checkObservation?: GitHubCheckObservation;
  requiredGitHubCheck?: Readonly<{
    repositoryId: string;
    scopeDigest: string;
    checkName: string;
    acceptableConclusions: readonly ("SUCCESS" | "NEUTRAL" | "SKIPPED")[];
  }>;
  localEvidence?: LocalGateEvidence;
}>;

export interface GateCoordinator {
  inspectManifest(query: InspectGateManifest): Promise<Result<GateManifestSummary>>;
  approveFingerprint(
    command: ApproveGateFingerprint,
  ): Promise<Result<Readonly<{ fingerprint: string }>>>;
  evaluate(command: EvaluateGate): Promise<Result<GateEvaluation>>;
}
