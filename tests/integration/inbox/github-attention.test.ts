import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "../../../src/server/db/migrate.ts";
import { commandCenterCard } from "../../../src/server/modules/inbox/command-center.ts";
import { githubInboxEvent } from "../../../src/server/modules/inbox/github-events.ts";
import { markInboxRead, upsertInboxEvent } from "../../../src/server/modules/inbox/inbox.ts";

test("GitHub attention deduplicates, preserves personal read state, and materially re-unreads", () => {
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  database.exec(
    "INSERT INTO deployments(id, singleton, team_id, revision, created_at) VALUES ('deployment_1', 1, 'team_1', 1, 0); INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at) VALUES ('member_1', 'Member', 'MEMBER', 'ACTIVE', 1, 1, 0)",
  );
  const event = githubInboxEvent({
    recipientMemberId: "member_1",
    eventId: "event_1",
    subjectKey: "ISSUE:101:42",
    category: "WARNING",
    safeSummary: "GitHub connector needs attention",
    sourceRevision: "v1",
  });
  const first = upsertInboxEvent(database, { ...event, now: 1 });
  const replay = upsertInboxEvent(database, { ...event, now: 2 });
  expect(first.ok && replay.ok && replay.value.revision).toBe(1);
  expect(
    markInboxRead(database, {
      recipientMemberId: "member_1",
      eventType: "WARNING",
      subjectKey: event.subjectKey,
      expectedRevision: 1,
      now: 3,
    }).ok,
  ).toBe(true);
  const changed = upsertInboxEvent(database, {
    ...githubInboxEvent({
      ...event,
      eventId: "event_2",
      safeSummary: "GitHub connector scope changed",
      sourceRevision: "v2",
    }),
    now: 4,
  });
  expect(changed).toMatchObject({ ok: true, value: { unread: true, revision: 3 } });
  if (changed.ok)
    expect(commandCenterCard(changed.value)).toMatchObject({
      lane: "NEEDS_ATTENTION",
      draggable: false,
    });
  database.close();
});
