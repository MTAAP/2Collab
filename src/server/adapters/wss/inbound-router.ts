import type { VerifiedRunnerPrincipal } from "../../../shared/contracts/actors.ts";
import { type RunnerEnvelope, RunnerEnvelopeSchema } from "../../../shared/contracts/protocol.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { RunnerSemanticAcceptance } from "./execution-authority.ts";

type Accepted = Readonly<{
  accepted: true;
  disposition?: "APPLIED" | "REJECTED";
  response?: RunnerSemanticAcceptance["response"];
}>;
type Routed = Accepted | Readonly<{ accepted: false; code: string }>;

type Dependencies = Readonly<{
  principal: VerifiedRunnerPrincipal;
  currentFence: () => boolean;
  heartbeat: (
    command: Readonly<{
      principal: VerifiedRunnerPrincipal;
      repositoryObservations: Extract<
        RunnerEnvelope["body"],
        Readonly<{ kind: "HEARTBEAT" }>
      >["repositoryObservations"];
    }>,
  ) => Promise<Result<unknown>>;
  acknowledgeDelivery: (deliveryId: string, semanticDigest: string) => Routed;
  acceptSemantic: (
    body: Exclude<
      RunnerEnvelope["body"],
      Readonly<{
        kind: "HEARTBEAT" | "HEADLESS_OUTPUT_CHUNK" | "OPERATION_ACKNOWLEDGEMENT" | "GATE_EVENT";
      }>
    >,
    actor: VerifiedRunnerPrincipal,
    semanticContinuity: RunnerEnvelope["semanticContinuity"],
  ) => Promise<Result<RunnerSemanticAcceptance>>;
  acceptOutput: (
    body: Extract<RunnerEnvelope["body"], Readonly<{ kind: "HEADLESS_OUTPUT_CHUNK" }>>,
  ) => Routed;
  acceptGateEvent: (
    body: Extract<RunnerEnvelope["body"], Readonly<{ kind: "GATE_EVENT" }>>,
    actor: VerifiedRunnerPrincipal,
  ) => Promise<Result<unknown>>;
}>;

function fromResult(result: Result<unknown>): Routed {
  return result.ok ? { accepted: true } : { accepted: false, code: result.error.code };
}

function fromSemanticResult(result: Result<RunnerSemanticAcceptance>): Routed {
  return result.ok
    ? {
        accepted: true,
        disposition: result.value.disposition,
        ...(result.value.response ? { response: result.value.response } : {}),
      }
    : { accepted: false, code: result.error.code };
}

export function createRunnerInboundRouter(dependencies: Dependencies) {
  const current = (): Routed | null =>
    dependencies.currentFence() ? null : { accepted: false, code: "CONNECTION_FENCED" };

  return {
    async route(candidate: RunnerEnvelope): Promise<Routed> {
      const parsed = RunnerEnvelopeSchema.safeParse(candidate);
      if (!parsed.success) return { accepted: false, code: "FRAME_INVALID" };
      const fenced = current();
      if (fenced) return fenced;
      const body = parsed.data.body;
      if (body.kind === "HEARTBEAT") {
        return fromResult(
          await dependencies.heartbeat({
            principal: dependencies.principal,
            repositoryObservations: body.repositoryObservations,
          }),
        );
      }
      if (body.kind === "OPERATION_ACKNOWLEDGEMENT") {
        return dependencies.acknowledgeDelivery(body.deliveryId, body.semanticDigest);
      }
      if (body.kind === "HEADLESS_OUTPUT_CHUNK") {
        return dependencies.acceptOutput(body);
      }
      if (body.kind === "GATE_EVENT") {
        return fromResult(await dependencies.acceptGateEvent(body, dependencies.principal));
      }
      if (
        ["ATTEMPT_EVENT", "CHECKPOINT", "EVIDENCE", "RUN_RESULT"].includes(body.kind) &&
        !parsed.data.semanticContinuity
      ) {
        return { accepted: false, code: "RUNNER_SEMANTIC_CONTINUITY_REQUIRED" };
      }
      return fromSemanticResult(
        await dependencies.acceptSemantic(
          body,
          dependencies.principal,
          parsed.data.semanticContinuity,
        ),
      );
    },
  };
}
