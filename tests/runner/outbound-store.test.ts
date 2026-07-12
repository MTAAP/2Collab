import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRunnerDatabase } from "../../src/runner/db/connection.ts";
import { createSqliteRunnerOutboundStore } from "../../src/runner/transport/sqlite-outbound-store.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("runner semantic outbox persists stable events and rejects conflicting replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "collab-runner-outbox-"));
  directories.push(directory);
  const path = join(directory, "runner.db");
  let database = openRunnerDatabase(path);
  let store = createSqliteRunnerOutboundStore(database, () => 1_000);
  const body = {
    kind: "ATTEMPT_EVENT",
    eventId: "event_1",
    payload: {
      runId: "run_1",
      expectedRunRevision: 1,
      attemptId: "attempt_1",
      expectedAttemptRevision: 1,
      event: { kind: "PROCESS_STARTED", observedAt: 1_000 },
    },
  } as const;
  const digest = createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
  expect(store.put({ eventId: body.eventId, digest, body })).toMatchObject({
    localSequence: 1,
  });
  store.put({ eventId: body.eventId, digest, body });
  database.close();

  database = openRunnerDatabase(path);
  store = createSqliteRunnerOutboundStore(database, () => 1_001);
  expect(store.load()).toEqual([{ eventId: "event_1", digest, body, localSequence: 1 }]);
  const changedBody = {
    ...body,
    payload: {
      ...body.payload,
      event: { kind: "PROCESS_EXITED", observedAt: 1_000, exitCode: 1 },
    },
  } as const;
  const changedDigest = createHash("sha256")
    .update(JSON.stringify(changedBody), "utf8")
    .digest("hex");
  expect(() =>
    store.put({
      eventId: "event_1",
      digest: changedDigest,
      body: changedBody,
    }),
  ).toThrow("RUNNER_EVENT_ID_CONFLICT");
  store.remove("event_1");
  expect(store.load()).toEqual([]);
  database.close();
});
