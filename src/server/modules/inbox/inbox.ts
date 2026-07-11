import type { Database } from "bun:sqlite";
import type { Result } from "../../../shared/contracts/result.ts";

export type InboxCategory = "ACTION_REQUIRED" | "BLOCKED" | "WARNING" | "OUTCOME";
export type InboxItem = Readonly<{
  recipientMemberId: string;
  eventType: InboxCategory;
  eventId: string;
  subjectKey: string;
  category: InboxCategory;
  materialDigest: string;
  safeSummary: string;
  unread: boolean;
  createdAt: number;
  updatedAt: number;
  revision: number;
}>;

export function upsertInboxEvent(
  database: Database,
  input: Omit<InboxItem, "unread" | "createdAt" | "updatedAt" | "revision"> &
    Readonly<{ sourceRevision?: string; now: number }>,
): Result<InboxItem> {
  if (
    !/^[a-f0-9]{64}$/.test(input.materialDigest) ||
    input.safeSummary.length < 1 ||
    input.safeSummary.length > 240
  )
    return {
      ok: false,
      error: { code: "INBOX_EVENT_INVALID", message: "Inbox event is invalid.", retry: "NEVER" },
    };
  const existing = database
    .query<
      { material_digest: string; unread: number; created_at: number; revision: number },
      [string, string, string]
    >(
      "SELECT material_digest, unread, created_at, revision FROM inbox_items WHERE recipient_member_id = ? AND event_type = ? AND subject_key = ?",
    )
    .get(input.recipientMemberId, input.eventType, input.subjectKey);
  if (existing?.material_digest === input.materialDigest)
    return {
      ok: true,
      value: {
        ...input,
        unread: Boolean(existing.unread),
        createdAt: existing.created_at,
        updatedAt: input.now,
        revision: existing.revision,
      },
    };
  try {
    database
      .query(`INSERT INTO inbox_items(recipient_member_id, event_type, event_id, subject_key, category, material_digest, safe_summary, unread, created_at, last_material_change_at, source_revision, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)
      ON CONFLICT(recipient_member_id, event_type, subject_key) DO UPDATE SET event_id = excluded.event_id, category = excluded.category, material_digest = excluded.material_digest, safe_summary = excluded.safe_summary, unread = 1, last_material_change_at = excluded.last_material_change_at, read_at = NULL, resolved_at = NULL, resolution_reason = NULL, source_revision = excluded.source_revision, updated_at = excluded.updated_at, revision = inbox_items.revision + 1`)
      .run(
        input.recipientMemberId,
        input.eventType,
        input.eventId,
        input.subjectKey,
        input.category,
        input.materialDigest,
        input.safeSummary,
        input.now,
        input.now,
        input.sourceRevision ?? null,
        input.now,
      );
    const row = database
      .query<{ unread: number; created_at: number; revision: number }, [string, string, string]>(
        "SELECT unread, created_at, revision FROM inbox_items WHERE recipient_member_id = ? AND event_type = ? AND subject_key = ?",
      )
      .get(input.recipientMemberId, input.eventType, input.subjectKey);
    if (!row) throw new Error("missing");
    return {
      ok: true,
      value: {
        ...input,
        unread: Boolean(row.unread),
        createdAt: row.created_at,
        updatedAt: input.now,
        revision: row.revision,
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "INBOX_STORAGE_FAILED",
        message: "Inbox event could not be stored.",
        retry: "SAME_INPUT",
      },
    };
  }
}

export function markInboxRead(
  database: Database,
  input: Readonly<{
    recipientMemberId: string;
    eventType: InboxCategory;
    subjectKey: string;
    expectedRevision: number;
    now: number;
  }>,
): Result<Readonly<{ revision: number }>> {
  const changed = database
    .query(
      "UPDATE inbox_items SET unread = 0, read_at = ?, updated_at = ?, revision = revision + 1 WHERE recipient_member_id = ? AND event_type = ? AND subject_key = ? AND revision = ?",
    )
    .run(
      input.now,
      input.now,
      input.recipientMemberId,
      input.eventType,
      input.subjectKey,
      input.expectedRevision,
    );
  return changed.changes === 1
    ? { ok: true, value: { revision: input.expectedRevision + 1 } }
    : {
        ok: false,
        error: { code: "INBOX_REVISION_STALE", message: "Inbox item changed.", retry: "REFRESH" },
      };
}

export function purgeResolvedInbox(database: Database, now: number): number {
  return database
    .query("DELETE FROM inbox_items WHERE resolved_at IS NOT NULL AND resolved_at <= ?")
    .run(now - 90 * 24 * 60 * 60 * 1000).changes;
}
