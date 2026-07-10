import type { TeamInvitation } from "../../../shared/contracts/identity.ts";

export function invitationState(
  row: {
    expires_at: number;
    consumed_at: number | null;
    revoked_at: number | null;
    exchange_id?: string | null;
  },
  now: number,
): TeamInvitation["state"] {
  if (row.consumed_at !== null) return "ACCEPTED";
  if (row.revoked_at !== null) return "REVOKED";
  if (now >= row.expires_at) return "EXPIRED";
  if (row.exchange_id) return "EXCHANGED";
  return "PENDING";
}
