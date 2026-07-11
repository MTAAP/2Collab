import { describe, expect, test } from "bun:test";
import {
  createProjectionSession,
  createProjectionSseHandler,
  type ProjectionSourcePort,
} from "../../src/server/adapters/http/sse.ts";
import {
  PublicProjectionEventSchema,
  PublicProjectionResetSchema,
} from "../../src/shared/contracts/projections.ts";

const ACTOR = {
  kind: "MEMBER" as const,
  memberId: "member_1" as never,
  sessionId: "session_1" as never,
  sessionProof: "verified-request-proof-with-at-least-thirty-two-bytes",
};

function event(cursor: number, projectId = "project_1") {
  return {
    kind: "PROJECTION" as const,
    cursor,
    committed: true as const,
    projectId,
    occurredAt: 100 + cursor,
    data: {
      kind: "RUN_CHANGED" as const,
      run: {
        id: `run_${cursor}`,
        coordinationRecordId: "record_1",
        state: "QUEUED" as const,
        goal: "Bounded projection",
        repositoryMode: "INSPECT_ONLY" as const,
        repositoryAssurance: "ADVISORY" as const,
        revision: 1,
        attemptIds: [],
      },
    },
  };
}

function source(events = [event(3)]): ProjectionSourcePort & {
  publish(value: ReturnType<typeof event>): Promise<void>;
} {
  let listener: ((value: ReturnType<typeof event>) => void | Promise<void>) | undefined;
  return {
    async replay() {
      return {
        oldestCursor: events.length === 0 ? 0 : 1,
        latestCursor: events.at(-1)?.cursor ?? 0,
        events,
      };
    },
    async authorize(_actor, value) {
      return value.projectId === "project_1";
    },
    subscribe(input) {
      listener = input.onEvent as typeof listener;
      return () => {
        listener = undefined;
      };
    },
    async publish(value) {
      await listener?.(value);
    },
  };
}

describe("authenticated projection SSE", () => {
  test("strict projection DTOs exclude runner controls, permits, local paths, and interactive bytes", () => {
    expect(PublicProjectionEventSchema.safeParse(event(1)).success).toBeTrue();
    for (const forbidden of [
      { runnerId: "runner_1" },
      { permit: "clear-permit" },
      { localPath: "/Users/alice/work" },
      { interactiveBytes: "raw-terminal" },
    ]) {
      expect(
        PublicProjectionEventSchema.safeParse({ ...event(1), ...forbidden }).success,
      ).toBeFalse();
    }
    expect(
      PublicProjectionResetSchema.safeParse({
        kind: "RESET",
        cursor: 12,
        reason: "CURSOR_STALE",
      }).success,
    ).toBeTrue();
  });

  test("actual SSE emits only authorized committed projections with monotonic ids", async () => {
    const projections = source([event(3), event(4, "project_forbidden")]);
    const handler = createProjectionSseHandler({
      authentication: {
        async authenticateBrowser() {
          return { ok: true, value: ACTOR };
        },
      },
      projections,
      replayLimit: 16,
      queueLimit: 4,
    });
    const response = await handler(
      new Request("https://collab.example/api/v1/events", {
        headers: { cookie: "collab_session=session_1.proof", "last-event-id": "2" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    const first = await reader?.read();
    await reader?.cancel();
    const text = new TextDecoder().decode(first?.value);
    expect(text).toContain("id: 3");
    expect(text).toContain("event: projection");
    expect(text).not.toContain("project_forbidden");
  });

  test("stale cursors receive one typed reset at the latest committed cursor", async () => {
    const projections = source([event(10), event(12)]);
    projections.replay = async () => ({
      oldestCursor: 10,
      latestCursor: 12,
      events: [event(10), event(12)],
    });
    const session = await createProjectionSession({
      actor: ACTOR,
      afterCursor: 2,
      projections,
      replayLimit: 16,
      queueLimit: 4,
    });
    expect(await session.next()).toEqual({
      done: false,
      value: { kind: "RESET", cursor: 12, reason: "CURSOR_STALE" },
    });
    expect(await session.next()).toEqual({ done: true, value: undefined });
  });

  test("invalid cursor order and slow consumers reset instead of dropping silently", async () => {
    const invalid = source([event(4), event(3)]);
    invalid.replay = async () => ({
      oldestCursor: 1,
      latestCursor: 4,
      events: [event(4), event(3)],
    });
    const invalidSession = await createProjectionSession({
      actor: ACTOR,
      afterCursor: 2,
      projections: invalid,
      replayLimit: 16,
      queueLimit: 4,
    });
    expect(await invalidSession.next()).toEqual({
      done: false,
      value: { kind: "RESET", cursor: 4, reason: "STREAM_INVALID" },
    });

    const live = source([]);
    const slow = await createProjectionSession({
      actor: ACTOR,
      afterCursor: 0,
      projections: live,
      replayLimit: 16,
      queueLimit: 2,
    });
    await live.publish(event(1));
    await live.publish(event(2));
    await live.publish(event(3));
    expect(await slow.next()).toEqual({
      done: false,
      value: { kind: "RESET", cursor: 3, reason: "SLOW_CONSUMER" },
    });
    expect(await slow.next()).toEqual({ done: true, value: undefined });
  });
});
