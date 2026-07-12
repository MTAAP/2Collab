import { createHash } from "node:crypto";
import type { VerifiedRunnerPrincipal } from "../../../shared/contracts/actors.ts";
import {
  type RunnerEnvelope,
  RunnerEnvelopeSchema,
  type ServerEnvelope,
} from "../../../shared/contracts/protocol.ts";
import { createInMemoryRunnerProtocolChannel } from "./protocol.ts";
import type { createRunnerChannel } from "./runner-channel.ts";
import {
  createRunnerUpgradeAuthenticator,
  type RunnerUpgradeAuthenticationAuthority,
} from "./upgrade-auth.ts";

type RunnerChannel = ReturnType<typeof createRunnerChannel>;
type Routed =
  | Readonly<{
      accepted: true;
      disposition?: "APPLIED" | "REJECTED";
      response?: ServerEnvelope["body"];
    }>
  | Readonly<{ accepted: false; code: string }>;

export interface RunnerControlSocket {
  readonly data: unknown;
  send(value: string, compress?: boolean): number;
  close(code: number, reason: string): void;
  getBufferedAmount?(): number;
}

type UpgradeServer = Readonly<{
  upgrade(
    request: Request,
    options: Readonly<{ data: Readonly<{ principal: VerifiedRunnerPrincipal }> }>,
  ): boolean;
}>;

type Scheduler = Readonly<{
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

type CoreDependencies = Readonly<{
  channel: RunnerChannel;
  now: () => number;
  scheduler?: Scheduler;
  supportedVersions?: readonly string[];
  createRouter: (
    principal: VerifiedRunnerPrincipal,
    currentFence: () => boolean,
    connectionId: string,
  ) => Readonly<{ route(envelope: RunnerEnvelope): Promise<Routed> }>;
}>;

type BunDependencies = CoreDependencies &
  Readonly<{
    authority: RunnerUpgradeAuthenticationAuthority;
    secureTransport(request: Request): boolean;
  }>;

type Session = {
  socket: RunnerControlSocket;
  principal: VerifiedRunnerPrincipal;
  connectionId: string;
  fence: number;
  protocol: ReturnType<typeof createInMemoryRunnerProtocolChannel>;
  router: ReturnType<CoreDependencies["createRouter"]>;
  effects: Promise<void>;
  timer?: unknown;
  closed: boolean;
};

function defaultScheduler(): Scheduler {
  return {
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function closeFacts(reason: "FENCED" | "REVOKED" | "QUIESCE"): readonly [number, string] {
  if (reason === "QUIESCE") return [1012, "SERVICE_RESTART"];
  if (reason === "FENCED") return [4001, "CONNECTION_FENCED"];
  return [4003, "RUNNER_REVOKED"];
}

function createCore(dependencies: CoreDependencies) {
  const scheduler = dependencies.scheduler ?? defaultScheduler();
  const sessions = new Set<Session>();
  const bySocket = new WeakMap<object, Session>();
  let quiesced = false;
  const acceptedEvents = new Map<
    string,
    Readonly<{
      digest: string;
      disposition: "APPLIED" | "REJECTED";
      response?: ServerEnvelope["body"];
    }>
  >();
  const maximumAcceptedEvents = 32_768;

  const eventFacts = (
    principal: VerifiedRunnerPrincipal,
    envelope: RunnerEnvelope,
  ): Readonly<{ key: string; eventId: string; digest: string }> | null => {
    const body = envelope.body;
    if (body.kind === "HEARTBEAT" || body.kind === "HEADLESS_OUTPUT_CHUNK") return null;
    return {
      key: `${principal.runnerId}:${body.eventId}`,
      eventId: body.eventId,
      digest: createHash("sha256")
        .update(
          JSON.stringify({ body, semanticContinuity: envelope.semanticContinuity ?? null }),
          "utf8",
        )
        .digest("hex"),
    };
  };

  const cancelTimer = (session: Session): void => {
    if (session.timer !== undefined) scheduler.clearTimeout(session.timer);
    session.timer = undefined;
  };

  const close = (session: Session, code: number, reason: string): void => {
    if (session.closed) return;
    session.closed = true;
    cancelTimer(session);
    session.socket.close(code, reason);
  };

  const scheduleTimeout = (session: Session, seconds: number): void => {
    cancelTimer(session);
    session.timer = scheduler.setTimeout(() => {
      session.timer = undefined;
      const timeout = session.protocol.checkTimeout();
      if (timeout && !timeout.accepted) close(session, 1008, timeout.code);
    }, seconds * 1_000);
  };

  const sendEnvelope = (socket: RunnerControlSocket, value: unknown): number | false => {
    if ((socket.getBufferedAmount?.() ?? 0) >= 1024 * 1024) return false;
    return socket.send(JSON.stringify(value), false);
  };

  const open = (socket: RunnerControlSocket, principal: VerifiedRunnerPrincipal): Session => {
    if (quiesced) throw new Error("RUNNER_UPGRADES_QUIESCED");
    let session: Session;
    const registered = dependencies.channel.attach(
      principal.runnerId,
      (envelope) => sendEnvelope(socket, envelope),
      (reason) => {
        const facts = closeFacts(reason);
        close(session, facts[0], facts[1]);
      },
    );
    const protocol = createInMemoryRunnerProtocolChannel({
      supportedVersions: dependencies.supportedVersions,
      now: dependencies.now,
      connectionId: () => registered.connectionId,
      fence: registered.fence,
    });
    session = {
      socket,
      principal,
      ...registered,
      protocol,
      router: dependencies.createRouter(
        principal,
        () =>
          dependencies.channel.isCurrent(
            principal.runnerId,
            registered.connectionId,
            registered.fence,
          ),
        registered.connectionId,
      ),
      effects: Promise.resolve(),
      closed: false,
    };
    sessions.add(session);
    bySocket.set(socket as object, session);
    scheduleTimeout(session, 10);
    return session;
  };

  const receive = (session: Session, message: string | Uint8Array | ArrayBuffer): void => {
    if (session.closed) return;
    const result =
      typeof message === "string"
        ? session.protocol.receiveText(message)
        : session.protocol.receiveBinary(
            message instanceof Uint8Array ? message : new Uint8Array(message),
          );
    if (!result.accepted) {
      close(session, 1002, result.code);
      return;
    }
    if (result.welcome) {
      if (!sendEnvelope(session.socket, result.welcome)) {
        close(session, 1011, "SEND_BACKPRESSURE");
        return;
      }
      scheduleTimeout(session, 30);
      void dependencies.channel
        .resendPending(session.principal.runnerId)
        .catch(() => close(session, 1011, "INTERNAL_ERROR"));
      return;
    }
    if (result.duplicate || typeof message !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      close(session, 1002, "FRAME_JSON_INVALID");
      return;
    }
    const envelope = RunnerEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      close(session, 1002, "FRAME_INVALID");
      return;
    }
    if (envelope.data.body.kind === "HEARTBEAT") scheduleTimeout(session, 30);
    session.effects = session.effects
      .then(async () => {
        const facts = eventFacts(session.principal, envelope.data);
        const prior = facts ? acceptedEvents.get(facts.key) : undefined;
        if (facts && prior !== undefined) {
          if (prior.digest !== facts.digest) {
            close(session, 1002, "SEMANTIC_EVENT_CONFLICT");
            return;
          }
          if (
            prior.response &&
            !dependencies.channel.sendTransient(session.principal.runnerId, prior.response)
          ) {
            return;
          }
          dependencies.channel.sendTransient(session.principal.runnerId, {
            kind: "SEMANTIC_EVENT_ACK",
            eventId: facts.eventId,
            disposition: "DUPLICATE",
          });
          return;
        }
        const routed = await session.router.route(envelope.data);
        if (!routed.accepted && routed.code === "CONNECTION_FENCED") {
          close(session, 4001, "CONNECTION_FENCED");
          return;
        }
        if (envelope.data.body.kind === "HEARTBEAT" && routed.accepted) {
          const receivedAt = dependencies.now();
          dependencies.channel.sendTransient(session.principal.runnerId, {
            kind: "HEARTBEAT_ACK",
            receivedAt,
            nextHeartbeatAt: receivedAt + 10,
          });
          return;
        }
        if (facts) {
          if (routed.accepted) {
            const accepted = {
              digest: facts.digest,
              disposition: routed.disposition ?? "APPLIED",
              ...(routed.response ? { response: routed.response } : {}),
            } as const;
            acceptedEvents.set(facts.key, accepted);
            if (acceptedEvents.size > maximumAcceptedEvents) {
              const oldest = acceptedEvents.keys().next().value;
              if (oldest !== undefined) acceptedEvents.delete(oldest);
            }
            if (
              accepted.response &&
              !dependencies.channel.sendTransient(session.principal.runnerId, accepted.response)
            ) {
              return;
            }
          }
          dependencies.channel.sendTransient(session.principal.runnerId, {
            kind: "SEMANTIC_EVENT_ACK",
            eventId: facts.eventId,
            disposition: routed.accepted ? (routed.disposition ?? "APPLIED") : "REJECTED",
          });
        }
      })
      .catch(() => close(session, 1011, "INTERNAL_ERROR"));
  };

  const closed = (socket: RunnerControlSocket): void => {
    const session = bySocket.get(socket as object);
    if (!session) return;
    cancelTimer(session);
    sessions.delete(session);
    dependencies.channel.detach(session.principal.runnerId, session.connectionId, session.fence);
  };

  return {
    open,
    receive,
    receiveSocket(socket: RunnerControlSocket, message: string | Uint8Array | ArrayBuffer): void {
      const session = bySocket.get(socket as object);
      if (!session) {
        socket.close(1008, "AUTHENTICATION_REQUIRED");
        return;
      }
      receive(session, message);
    },
    closed,
    drain(socket: RunnerControlSocket): void {
      const session = bySocket.get(socket as object);
      if (session) {
        if ((socket.getBufferedAmount?.() ?? 0) === 0) {
          dependencies.channel.transportDrained(session.principal.runnerId);
        }
        dependencies.channel.flush(session.principal.runnerId);
        dependencies.channel.notifyDrain();
      }
    },
    async quiesce(deadline: number) {
      quiesced = true;
      for (const session of sessions) cancelTimer(session);
      const result = await dependencies.channel.quiesce(deadline);
      sessions.clear();
      return result;
    },
  };
}

export function createBunRunnerControlAdapter(dependencies: BunDependencies) {
  const core = createCore(dependencies);
  const authenticate = createRunnerUpgradeAuthenticator({ authority: dependencies.authority });
  return {
    async fetch(request: Request, server: UpgradeServer): Promise<Response | undefined | null> {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return new Response("Not found.", { status: 404 });
      }
      if (url.pathname !== "/runner/v1") return null;
      const principal = await authenticate(request, {
        secureTransport: dependencies.secureTransport(request),
      });
      if (!principal.ok) return new Response("Unauthorized.", { status: 401 });
      return server.upgrade(request, { data: { principal: principal.value } })
        ? undefined
        : new Response("Upgrade unavailable.", { status: 503 });
    },
    websocket: {
      open(socket: RunnerControlSocket): void {
        const data = socket.data as { principal?: VerifiedRunnerPrincipal } | undefined;
        if (data?.principal?.kind !== "VERIFIED_RUNNER") {
          socket.close(1008, "AUTHENTICATION_REQUIRED");
          return;
        }
        core.open(socket, data.principal);
      },
      message(socket: RunnerControlSocket, message: string | Uint8Array | ArrayBuffer): void {
        core.receiveSocket(socket, message);
      },
      close(socket: RunnerControlSocket): void {
        core.closed(socket);
      },
      drain(socket: RunnerControlSocket): void {
        core.drain(socket);
      },
      maxPayloadLength: 65_536,
      idleTimeout: 35,
      backpressureLimit: 1024 * 1024,
      closeOnBackpressureLimit: true,
      sendPings: false,
      perMessageDeflate: false,
    },
    quiesce: core.quiesce,
  };
}

export function createInMemoryRunnerControlAdapter(dependencies: CoreDependencies) {
  const core = createCore(dependencies);
  return {
    connect(principal: VerifiedRunnerPrincipal) {
      const socket = {
        data: { principal },
        sent: [] as string[],
        closes: [] as Array<readonly [number, string]>,
        send(value: string) {
          this.sent.push(value);
          return Buffer.byteLength(value, "utf8");
        },
        close(code: number, reason: string) {
          this.closes.push([code, reason]);
        },
        getBufferedAmount: () => 0,
      } satisfies RunnerControlSocket & {
        sent: string[];
        closes: Array<readonly [number, string]>;
      };
      const session = core.open(socket, principal);
      return {
        socket,
        receive: (message: string | Uint8Array) => core.receive(session, message),
        close: () => core.closed(socket),
      };
    },
    quiesce: core.quiesce,
  };
}
