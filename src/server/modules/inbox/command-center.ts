import type { InboxItem } from "./inbox.ts";
export type CommandCenterLane =
  | "NEEDS_ATTENTION"
  | "ACTIVE_NOW"
  | "WAITING_AND_SCHEDULED"
  | "RECENTLY_FINISHED";
export function commandCenterCard(
  item: InboxItem,
): Readonly<{ subjectKey: string; summary: string; lane: CommandCenterLane; draggable: false }> {
  const lane: CommandCenterLane =
    item.category === "ACTION_REQUIRED" ||
    item.category === "BLOCKED" ||
    item.category === "WARNING"
      ? "NEEDS_ATTENTION"
      : "RECENTLY_FINISHED";
  return { subjectKey: item.subjectKey, summary: item.safeSummary, lane, draggable: false };
}
