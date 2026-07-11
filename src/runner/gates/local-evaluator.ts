import type { RunnerActor } from "../../shared/contracts/actors.ts";
import type { ExecutionAuthority } from "../../shared/contracts/execution-authority.ts";
import {
  type AuthoritySessionId,
  CommitShaSchema,
  type IdempotencyKey,
  IdentifierSchema,
  Sha256Schema,
} from "../../shared/contracts/ids.ts";
import type { Result } from "../../shared/contracts/result.ts";
import type { ApprovedManifestLoader } from "./manifest-loader.ts";
import { z } from "zod";

export const LocalGateRequestSchema = z
  .object({
    gateEvaluationId: IdentifierSchema,
    gateKey: IdentifierSchema,
    repositoryRevision: CommitShaSchema,
    manifestFingerprint: Sha256Schema,
  })
  .strict();
export type LocalGateRequest = Readonly<z.infer<typeof LocalGateRequestSchema>>;
export type LocalGateProcessResult = Readonly<{
  exitCode: number | null;
  output: string;
  trackedMutation: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
}>;
export type LocalGateResult = Readonly<{
  state: "PASSED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
  exitCode: number | null;
  outputDigest: string;
  trackedMutation: boolean;
}>;
export type LocalGateContext = Readonly<{
  loader: ApprovedManifestLoader;
  authority: ExecutionAuthority;
  runnerActor: RunnerActor;
  sessionId: AuthoritySessionId;
  sessionFence: number;
  idempotencyKey: IdempotencyKey;
  projectId: string;
  trustedBaseRevision: string;
  observedRepositoryRevision: string;
  opaqueWorktreeId: string;
  spawn(
    argv: readonly string[],
    options: Readonly<{
      cwd: string;
      relativeDirectory: string;
      timeoutMs: number;
      maxOutputBytes: number;
      shell: false;
    }>,
  ): Promise<LocalGateProcessResult>;
}>;

const failure = (
  code: string,
  message: string,
  retry: "NEVER" | "REFRESH" | "EXPLICIT_RESUME" = "NEVER",
): Result<never> => ({ ok: false, error: { code, message, retry } });
export async function evaluateLocalGate(
  request: LocalGateRequest,
  context: LocalGateContext,
): Promise<Result<LocalGateResult>> {
  const parsedRequest = LocalGateRequestSchema.safeParse(request);
  if (!parsedRequest.success)
    return failure("GATE_REQUEST_INVALID", "Local gate request is invalid.");
  if (parsedRequest.data.repositoryRevision !== context.observedRepositoryRevision)
    return failure("GATE_REVISION_STALE", "Gate repository revision is stale.", "REFRESH");
  const bindingDigest = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(parsedRequest.data))
    .digest("hex");
  if (!context.loader.claimEvaluation(parsedRequest.data.gateEvaluationId, bindingDigest))
    return failure("GATE_EVALUATION_REPLAY", "Gate evaluation was already claimed.");
  const resolved = context.loader.resolve({
    projectId: context.projectId,
    baseRevision: context.trustedBaseRevision,
    fingerprint: parsedRequest.data.manifestFingerprint,
    gateKey: parsedRequest.data.gateKey,
  });
  if (!resolved.ok) return resolved;
  if (resolved.value.kind !== "LOCAL_COMMAND")
    return failure("GATE_KIND_INVALID", "Project gate is not a local command.");
  const authorization = await context.authority.execute({
    kind: "AUTHORIZE_OPERATION",
    idempotencyKey: context.idempotencyKey,
    actor: context.runnerActor,
    sessionId: context.sessionId,
    sessionFence: context.sessionFence,
    operation: {
      kind: "EXECUTE_LOCAL_GATE",
      gateEvaluationId: parsedRequest.data.gateEvaluationId as never,
      repositoryRevision: parsedRequest.data.repositoryRevision as never,
      manifestFingerprint: parsedRequest.data.manifestFingerprint as never,
    },
  });
  if (!authorization.ok) return authorization;
  const process = await context.spawn([resolved.value.executable, ...resolved.value.arguments], {
    cwd: context.opaqueWorktreeId,
    relativeDirectory: resolved.value.workingDirectory,
    timeoutMs: resolved.value.timeoutMs,
    maxOutputBytes: resolved.value.maxOutputBytes,
    shell: false,
  });
  const output = Buffer.from(
    [...process.output]
      .filter((character) => {
        const code = character.charCodeAt(0);
        return character === "\n" || character === "\t" || code >= 32;
      })
      .join(""),
  )
    .subarray(0, resolved.value.maxOutputBytes)
    .toString("utf8");
  const outputDigest = new Bun.CryptoHasher("sha256").update(output).digest("hex");
  const state = process.cancelled
    ? "CANCELLED"
    : process.timedOut
      ? "TIMED_OUT"
      : process.exitCode === 0 && !process.trackedMutation
        ? "PASSED"
        : "FAILED";
  return {
    ok: true,
    value: {
      state,
      exitCode: process.exitCode,
      outputDigest,
      trackedMutation: process.trackedMutation,
    },
  };
}
