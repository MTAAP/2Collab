import type { VerifiedRunnerPrincipal } from "../../../shared/contracts/actors.ts";
import { RunnerEnvelopeSchema, type RunnerEnvelope } from "../../../shared/contracts/protocol.ts";
import type { Result } from "../../../shared/contracts/result.ts";

type Accepted = Readonly<{ accepted: true }>;
type Routed = Accepted | Readonly<{ accepted: false; code: string }>;

type Dependencies = Readonly<{
  principal: VerifiedRunnerPrincipal;
  currentFence: () => boolean;
  heartbeat: (
    command: Readonly<{ principal: VerifiedRunnerPrincipal }>,
  ) => Promise<Result<unknown>>;
  acknowledgeDelivery: (deliveryId: string, semanticDigest: string) => Routed;
  acceptSemantic: (
    body: Exclude<RunnerEnvelope["body"], Readonly<{ kind: "HEARTBEAT" }>>,
    actor: VerifiedRunnerPrincipal,
  ) => Promise<Result<unknown>>;
  acceptOutput: (
    body: Extract<RunnerEnvelope["body"], Readonly<{ kind: "HEADLESS_OUTPUT_CHUNK" }>>,
  ) => Routed;
}>;

function fromResult(result: Result<unknown>): Routed {
  return result.ok ? { accepted: true } : { accepted: false, code: result.error.code };
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
        return fromResult(await dependencies.heartbeat({ principal: dependencies.principal }));
      }
      if (body.kind === "OPERATION_ACKNOWLEDGEMENT") {
        return dependencies.acknowledgeDelivery(body.deliveryId, body.semanticDigest);
      }
      if (body.kind === "HEADLESS_OUTPUT_CHUNK") {
        return dependencies.acceptOutput(body);
      }
      return fromResult(await dependencies.acceptSemantic(body, dependencies.principal));
    },
  };
}
