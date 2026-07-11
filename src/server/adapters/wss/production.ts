import type { Hono } from "hono";
import type { VerifiedRunnerPrincipal } from "../../../shared/contracts/actors.ts";
import type { RunnerEnvelope } from "../../../shared/contracts/protocol.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { createBunRunnerControlAdapter } from "./bun-runner-control.ts";
import type { RunnerSemanticAcceptance } from "./execution-authority.ts";
import { createRunnerInboundRouter } from "./inbound-router.ts";
import { type CommittedRunnerOperation, createRunnerChannel } from "./runner-channel.ts";
import type { RunnerUpgradeAuthenticationAuthority } from "./upgrade-auth.ts";

type Routed = Readonly<{ accepted: true }> | Readonly<{ accepted: false; code: string }>;
type SemanticBody = Exclude<
  RunnerEnvelope["body"],
  Readonly<{
    kind: "HEARTBEAT" | "HEADLESS_OUTPUT_CHUNK" | "OPERATION_ACKNOWLEDGEMENT" | "GATE_EVENT";
  }>
>;
type OutputBody = Extract<RunnerEnvelope["body"], Readonly<{ kind: "HEADLESS_OUTPUT_CHUNK" }>>;

export type ProductionRunnerPorts = Readonly<{
  authentication: RunnerUpgradeAuthenticationAuthority;
  now: () => number;
  messageId: () => string;
  secureTransport: (request: Request) => boolean;
  loadCommitted: (outboxIds: readonly string[]) => readonly CommittedRunnerOperation[];
  heartbeat: (principal: VerifiedRunnerPrincipal) => Promise<Result<unknown>>;
  acknowledgeDelivery: (
    principal: VerifiedRunnerPrincipal,
    deliveryId: string,
    semanticDigest: string,
  ) => Routed;
  acceptSemantic: (
    body: SemanticBody,
    principal: VerifiedRunnerPrincipal,
    connectionId: string,
  ) => Promise<Result<RunnerSemanticAcceptance>>;
  acceptOutput: (body: OutputBody, principal: VerifiedRunnerPrincipal) => Routed;
  acceptGateEvent: (
    body: Extract<RunnerEnvelope["body"], Readonly<{ kind: "GATE_EVENT" }>>,
    principal: VerifiedRunnerPrincipal,
  ) => Promise<Result<unknown>>;
}>;

type RunnerControlComposition<Server, Websocket> = Readonly<{
  fetch(request: Request, server: Server): Promise<Response | undefined | null>;
  websocket: Websocket;
}>;

const portsKey = Symbol.for("2collab.production.runner-ports.v1");

function validPorts(candidate: ProductionRunnerPorts): boolean {
  return (
    typeof candidate.authentication?.authenticateUpgrade === "function" &&
    typeof candidate.now === "function" &&
    typeof candidate.messageId === "function" &&
    typeof candidate.secureTransport === "function" &&
    typeof candidate.loadCommitted === "function" &&
    typeof candidate.heartbeat === "function" &&
    typeof candidate.acknowledgeDelivery === "function" &&
    typeof candidate.acceptSemantic === "function" &&
    typeof candidate.acceptOutput === "function" &&
    typeof candidate.acceptGateEvent === "function"
  );
}

export function installProductionRunnerPorts(ports: ProductionRunnerPorts): void {
  if (!validPorts(ports)) throw new Error("RUNNER_PRODUCTION_PORTS_INVALID");
  (globalThis as Record<symbol, unknown>)[portsKey] = ports;
}

export function requireProductionRunnerPorts(): ProductionRunnerPorts {
  const ports = (globalThis as Record<symbol, unknown>)[portsKey] as
    | ProductionRunnerPorts
    | undefined;
  if (!ports || !validPorts(ports)) throw new Error("RUNNER_PRODUCTION_PORTS_REQUIRED");
  return ports;
}

export function createServerEntrypoint<Server, Websocket>(
  input: Readonly<{
    app: Hono;
    runnerControl: RunnerControlComposition<Server, Websocket>;
    hostname: string;
    port: number;
  }>,
) {
  return {
    async fetch(request: Request, server: Server): Promise<Response | undefined> {
      const runner = await input.runnerControl.fetch(request, server);
      return runner === null ? input.app.fetch(request) : runner;
    },
    websocket: input.runnerControl.websocket,
    hostname: input.hostname,
    port: input.port,
  };
}

export function createProductionRunnerServer(
  input: Readonly<{
    app: Hono;
    hostname: string;
    port: number;
    ports: ProductionRunnerPorts;
  }>,
) {
  if (!validPorts(input.ports)) throw new Error("RUNNER_PRODUCTION_PORTS_REQUIRED");
  const channel = createRunnerChannel({
    now: input.ports.now,
    messageId: input.ports.messageId,
    loadCommitted: input.ports.loadCommitted,
  });
  const adapter = createBunRunnerControlAdapter({
    channel,
    now: input.ports.now,
    authority: input.ports.authentication,
    secureTransport: input.ports.secureTransport,
    createRouter: (principal, currentFence, connectionId) =>
      createRunnerInboundRouter({
        principal,
        currentFence,
        heartbeat: ({ principal: actor }) => input.ports.heartbeat(actor),
        acknowledgeDelivery: (deliveryId, semanticDigest) => {
          const committed = input.ports.acknowledgeDelivery(principal, deliveryId, semanticDigest);
          if (!committed.accepted) return committed;
          return channel.acknowledge(principal.runnerId, deliveryId, semanticDigest);
        },
        acceptSemantic: (body, actor) => input.ports.acceptSemantic(body, actor, connectionId),
        acceptOutput: (body) => input.ports.acceptOutput(body, principal),
        acceptGateEvent: (body, actor) => input.ports.acceptGateEvent(body, actor),
      }),
  });
  return {
    ...createServerEntrypoint({
      app: input.app,
      runnerControl: adapter,
      hostname: input.hostname,
      port: input.port,
    }),
    runnerControl: channel,
    quiesce: adapter.quiesce,
  };
}
