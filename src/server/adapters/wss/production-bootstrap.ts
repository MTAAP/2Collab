import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import type { VerifiedRunnerPrincipal } from "../../../shared/contracts/actors.ts";
import type { RunnerEnvelope } from "../../../shared/contracts/protocol.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { ServerEnvironment } from "../../../shared/environment.ts";
import { openDatabase } from "../../db/connection.ts";
import { migrate } from "../../db/migrate.ts";
import {
  type AuthorityFactPort,
  createExecutionAuthority,
  type PermitCodec,
  type RunConfigurationResolutionPort,
} from "../../modules/execution-authority/execution-authority.ts";
import type { RunnerKeyProofPort, RunnerRequestProofPort } from "../../modules/runners/contract.ts";
import { createRunnerServices } from "../../modules/runners/runner-registry.ts";
import { createRunnerEventDeduplicator } from "../../modules/runs/event-deduplication.ts";
import { createDurableRunnerDispatch } from "./durable-dispatch.ts";
import { createRunnerExecutionAuthorityAdapter } from "./execution-authority.ts";
import { LiveOutputHub } from "./live-output.ts";
import { createProductionRunnerServer } from "./production.ts";

type GateBody = Extract<RunnerEnvelope["body"], Readonly<{ kind: "GATE_EVENT" }>>;

export type ProductionRunnerInfrastructure = Readonly<{
  runnerKeyProof: RunnerKeyProofPort;
  runnerRequestProof: RunnerRequestProofPort;
  authorityFacts: AuthorityFactPort;
  runConfiguration: RunConfigurationResolutionPort;
  permitCodec: PermitCodec;
  defaultSecurityDigest: string;
  acceptGateEvent: (body: GateBody, principal: VerifiedRunnerPrincipal) => Promise<Result<unknown>>;
  id?: (prefix: string) => string;
}>;

const infrastructureKey = Symbol.for("2collab.production.runner-infrastructure.v1");

export function installProductionRunnerInfrastructure(
  infrastructure: ProductionRunnerInfrastructure,
): void {
  (globalThis as Record<symbol, unknown>)[infrastructureKey] = infrastructure;
}

function requireInfrastructure(): ProductionRunnerInfrastructure {
  const value = (globalThis as Record<symbol, unknown>)[infrastructureKey] as
    | ProductionRunnerInfrastructure
    | undefined;
  if (
    !value ||
    typeof value.runnerKeyProof?.verifyNewKey !== "function" ||
    typeof value.runnerKeyProof?.verifyPossession !== "function" ||
    typeof value.runnerRequestProof?.verify !== "function" ||
    typeof value.authorityFacts?.refresh !== "function" ||
    typeof value.runConfiguration?.resolve !== "function" ||
    typeof value.permitCodec?.sign !== "function" ||
    typeof value.permitCodec?.verify !== "function" ||
    typeof value.acceptGateEvent !== "function" ||
    !/^[a-f0-9]{64}$/.test(value.defaultSecurityDigest)
  ) {
    throw new Error("RUNNER_PRODUCTION_INFRASTRUCTURE_REQUIRED");
  }
  return value;
}

export async function createProductionServer(
  environment: ServerEnvironment,
  app: Hono,
  options: Readonly<{
    database?: ReturnType<typeof openDatabase>;
    infrastructure?: ProductionRunnerInfrastructure;
  }> = {},
) {
  const infrastructure = options.infrastructure ?? requireInfrastructure();
  const id =
    infrastructure.id ?? ((prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`);
  const now = () => Math.floor(Date.now() / 1_000);
  const directory = resolve(environment.dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = options.database ?? openDatabase(join(directory, "collab.sqlite"));
  if (!options.database) migrate(database);
  const runners = createRunnerServices({
    database,
    clock: now,
    id,
    defaultSecurityDigest: infrastructure.defaultSecurityDigest,
    runnerKeyProof: infrastructure.runnerKeyProof,
    runnerRequestProof: infrastructure.runnerRequestProof,
  });
  const output = new LiveOutputHub();
  const dispatch = createDurableRunnerDispatch({
    database,
    permitCodec: infrastructure.permitCodec,
    output,
  });
  let semantic: ReturnType<typeof createRunnerExecutionAuthorityAdapter>["accept"] | undefined;
  const server = createProductionRunnerServer({
    app,
    hostname: environment.hostname,
    port: environment.port,
    ports: {
      authentication: runners.authentication,
      now,
      messageId: () => id("server_message"),
      secureTransport: (request) => new URL(request.url).protocol === "https:",
      loadCommitted: dispatch.loadCommitted,
      heartbeat: (principal) =>
        runners.registry.heartbeat({ idempotencyKey: id("heartbeat") as never, principal }),
      acknowledgeDelivery: (principal, deliveryId, semanticDigest) => {
        const row = database
          .query<{ runner_id: string; semantic_digest: string; status: string }, [string]>(
            "SELECT runner_id, semantic_digest, status FROM runner_dispatch_outbox WHERE id = ?",
          )
          .get(deliveryId);
        if (
          !row ||
          row.runner_id !== principal.runnerId ||
          row.semantic_digest !== semanticDigest ||
          !["PENDING", "DISPATCHED", "ACKNOWLEDGED"].includes(row.status)
        ) {
          return { accepted: false, code: "DELIVERY_NOT_PENDING" };
        }
        if (row.status !== "ACKNOWLEDGED") {
          const receivedAt = now();
          database
            .query(
              `UPDATE runner_dispatch_outbox
               SET status = 'ACKNOWLEDGED', dispatched_at = coalesce(dispatched_at, ?),
                   acknowledged_at = ?
               WHERE id = ? AND status IN ('PENDING', 'DISPATCHED')`,
            )
            .run(receivedAt, receivedAt, deliveryId);
        }
        return { accepted: true };
      },
      acceptSemantic: (body, principal, connectionId, continuity) =>
        semantic
          ? semantic(body, principal, connectionId, continuity)
          : Promise.resolve({
              ok: false,
              error: {
                code: "EXECUTION_AUTHORITY_UNAVAILABLE",
                message: "Execution Authority is unavailable.",
                retry: "SAME_INPUT",
              },
            }),
      acceptOutput: (body) =>
        output.accept(
          body.target.kind,
          body.target.kind === "ATTEMPT" ? body.target.attemptId : body.target.gateEvaluationId,
          body.stream,
          body.sequence,
          body.text,
          body.redactionVersion,
          body.truncated,
        ),
      acceptGateEvent: (body, principal) => infrastructure.acceptGateEvent(body, principal),
    },
  });
  dispatch.bind(server.runnerControl);
  const authority = createExecutionAuthority({
    database,
    clock: now,
    id,
    authorityFacts: infrastructure.authorityFacts,
    runConfiguration: infrastructure.runConfiguration,
    permitCodec: infrastructure.permitCodec,
    runnerControl: dispatch.control,
    semanticEvents: createRunnerEventDeduplicator({
      database,
      clock: now,
      id: (kind) => id(kind),
    }),
  });
  semantic = createRunnerExecutionAuthorityAdapter(authority).accept;
  await dispatch.prime();
  return {
    ...server,
    database,
    output,
    authority,
    runnerRegistry: runners.registry,
    runnerAuthentication: runners.authentication,
  };
}
