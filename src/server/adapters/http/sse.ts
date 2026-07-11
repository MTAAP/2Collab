import type { MemberActor } from "../../../shared/contracts/actors.ts";
import {
  type PublicProjectionEvent,
  PublicProjectionEventSchema,
  type PublicProjectionMessage,
  type PublicProjectionReset,
} from "../../../shared/contracts/projections.ts";
import type { Result } from "../../../shared/contracts/result.ts";

export interface ProjectionSourcePort {
  replay(
    input: Readonly<{
      memberId: string;
      afterCursor: number;
      limit: number;
    }>,
  ): Promise<
    Readonly<{
      oldestCursor: number;
      latestCursor: number;
      events: readonly PublicProjectionEvent[];
    }>
  >;
  authorize(actor: MemberActor, event: PublicProjectionEvent): Promise<boolean>;
  subscribe(
    input: Readonly<{
      memberId: string;
      onEvent: (event: PublicProjectionEvent) => void | Promise<void>;
      onAuthorityChanged: () => void;
    }>,
  ): () => void;
}

type SessionInput = Readonly<{
  actor: MemberActor;
  afterCursor: number;
  projections: ProjectionSourcePort;
  replayLimit: number;
  queueLimit: number;
}>;

export interface ProjectionSession extends AsyncIterator<PublicProjectionMessage> {
  return(): Promise<IteratorResult<PublicProjectionMessage>>;
}

function validCursor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export async function createProjectionSession(input: SessionInput): Promise<ProjectionSession> {
  if (
    !validCursor(input.afterCursor) ||
    !Number.isInteger(input.replayLimit) ||
    input.replayLimit < 1 ||
    input.replayLimit > 100 ||
    !Number.isInteger(input.queueLimit) ||
    input.queueLimit < 1 ||
    input.queueLimit > 100
  ) {
    throw new Error("PROJECTION_STREAM_CONFIGURATION_INVALID");
  }
  const replay = await input.projections.replay({
    memberId: input.actor.memberId,
    afterCursor: input.afterCursor,
    limit: input.replayLimit,
  });
  const queue: PublicProjectionMessage[] = [];
  const waiters: Array<(result: IteratorResult<PublicProjectionMessage>) => void> = [];
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let lastCursor = input.afterCursor;

  const push = (message: PublicProjectionMessage) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
      return;
    }
    queue.push(message);
  };
  const finish = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    closed = true;
    while (queue.length === 0 && waiters.length > 0) {
      waiters.shift()?.({ done: true, value: undefined });
    }
  };
  const reset = (reason: PublicProjectionReset["reason"], cursor: number) => {
    queue.splice(0, queue.length, { kind: "RESET", cursor, reason });
    finish();
  };

  if (
    !validCursor(replay.oldestCursor) ||
    !validCursor(replay.latestCursor) ||
    replay.oldestCursor > replay.latestCursor ||
    replay.events.length > input.replayLimit
  ) {
    reset("STREAM_INVALID", validCursor(replay.latestCursor) ? replay.latestCursor : 0);
  } else if (
    input.afterCursor > 0 &&
    replay.latestCursor > 0 &&
    input.afterCursor < replay.oldestCursor - 1
  ) {
    reset("CURSOR_STALE", replay.latestCursor);
  } else {
    for (const raw of replay.events) {
      const parsed = PublicProjectionEventSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.cursor <= lastCursor ||
        parsed.data.cursor > replay.latestCursor
      ) {
        reset("STREAM_INVALID", replay.latestCursor);
        break;
      }
      lastCursor = parsed.data.cursor;
      if (await input.projections.authorize(input.actor, parsed.data)) push(parsed.data);
    }
  }

  let serialized = Promise.resolve();
  if (!closed) {
    unsubscribe = input.projections.subscribe({
      memberId: input.actor.memberId,
      onEvent(raw) {
        serialized = serialized.then(async () => {
          if (closed) return;
          const parsed = PublicProjectionEventSchema.safeParse(raw);
          if (!parsed.success || parsed.data.cursor <= lastCursor) {
            reset("STREAM_INVALID", Math.max(lastCursor, raw.cursor));
            return;
          }
          lastCursor = parsed.data.cursor;
          if (!(await input.projections.authorize(input.actor, parsed.data))) return;
          if (queue.length >= input.queueLimit) {
            reset("SLOW_CONSUMER", parsed.data.cursor);
            return;
          }
          push(parsed.data);
        });
        return serialized;
      },
      onAuthorityChanged() {
        if (!closed) reset("AUTHORITY_CHANGED", lastCursor);
      },
    });
  }

  return {
    next() {
      const value = queue.shift();
      if (value) return Promise.resolve({ done: false as const, value });
      if (closed) return Promise.resolve({ done: true as const, value: undefined });
      return new Promise((resolve) => waiters.push(resolve));
    },
    async return() {
      queue.splice(0);
      finish();
      return { done: true as const, value: undefined };
    },
  };
}

function sseFrame(message: PublicProjectionMessage): Uint8Array {
  const eventName = message.kind === "RESET" ? "reset" : "projection";
  return new TextEncoder().encode(
    `id: ${message.cursor}\nevent: ${eventName}\ndata: ${JSON.stringify(message)}\n\n`,
  );
}

export function createProjectionSseHandler(
  dependencies: Readonly<{
    authentication: Readonly<{
      authenticateBrowser(request: Request): Promise<Result<MemberActor>>;
    }>;
    projections: ProjectionSourcePort;
    replayLimit: number;
    queueLimit: number;
  }>,
) {
  return async (request: Request): Promise<Response> => {
    if (
      request.method !== "GET" ||
      !request.headers.has("cookie") ||
      request.headers.has("authorization") ||
      request.headers.has("dpop") ||
      request.headers.has("dpop-nonce")
    ) {
      return Response.json(
        { error: { code: "SESSION_REQUIRED", message: "Member session is required." } },
        { status: 401 },
      );
    }
    const authenticated = await dependencies.authentication.authenticateBrowser(request);
    if (!authenticated.ok) return Response.json(authenticated, { status: 401 });
    const cursorHeader = request.headers.get("last-event-id");
    if (cursorHeader !== null && !/^(?:0|[1-9][0-9]*)$/.test(cursorHeader)) {
      return Response.json(
        { error: { code: "CURSOR_INVALID", message: "Projection cursor is invalid." } },
        { status: 400 },
      );
    }
    const afterCursor = Number(cursorHeader ?? 0);
    if (!Number.isSafeInteger(afterCursor)) {
      return Response.json(
        { error: { code: "CURSOR_INVALID", message: "Projection cursor is invalid." } },
        { status: 400 },
      );
    }
    const session = await createProjectionSession({
      actor: authenticated.value,
      afterCursor,
      projections: dependencies.projections,
      replayLimit: dependencies.replayLimit,
      queueLimit: dependencies.queueLimit,
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await session.next();
        if (next.done) controller.close();
        else controller.enqueue(sseFrame(next.value));
      },
      async cancel() {
        await session.return();
      },
    });
    return new Response(body, {
      headers: {
        "cache-control": "no-store",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    });
  };
}
