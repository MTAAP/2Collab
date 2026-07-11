import type { Database } from "bun:sqlite";
import type { Result } from "../shared/contracts/result.ts";
import type { HostProcess } from "./execution-contract.ts";

export type ProcessReservation = Readonly<{
  reservationId: string;
  disposition: "NEW" | "RESUME" | "RECONCILE";
}>;

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function createLocalProcessRegistry(
  database: Database,
  clock: () => number,
  id: () => string,
) {
  return {
    reserve(attemptId: string, assignmentDigest: string): Result<ProcessReservation> {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(attemptId) ||
        !/^[0-9a-f]{64}$/.test(assignmentDigest)
      ) {
        return failure("PROCESS_ASSIGNMENT_INVALID", "Process assignment is invalid.");
      }
      const existing = database
        .query<{ reservation_id: string; assignment_digest: string; state: string }, [string]>(
          "SELECT reservation_id, assignment_digest, state FROM local_processes WHERE attempt_id = ?",
        )
        .get(attemptId);
      if (existing) {
        return existing.assignment_digest === assignmentDigest
          ? {
              ok: true,
              value: {
                reservationId: existing.reservation_id,
                disposition: existing.state === "RESERVED" ? "RESUME" : "RECONCILE",
              },
            }
          : failure("PROCESS_ASSIGNMENT_CONFLICT", "Process assignment changed.");
      }
      const reservationId = id();
      try {
        database
          .query(
            `INSERT INTO local_processes(
               attempt_id, reservation_id, assignment_digest, state, created_at, updated_at
             ) VALUES (?, ?, ?, 'RESERVED', ?, ?)`,
          )
          .run(attemptId, reservationId, assignmentDigest, clock(), clock());
        return { ok: true, value: { reservationId, disposition: "NEW" } };
      } catch {
        return failure("PROCESS_STATE_FAILED", "Local process state failed.");
      }
    },

    release(reservation: ProcessReservation): Result<void> {
      try {
        const changed = database
          .query("DELETE FROM local_processes WHERE reservation_id = ? AND state = 'RESERVED'")
          .run(reservation.reservationId);
        return changed.changes === 1
          ? { ok: true, value: undefined }
          : failure("PROCESS_STATE_CONFLICT", "Local process state changed.");
      } catch {
        return failure("PROCESS_STATE_FAILED", "Local process state failed.");
      }
    },

    recordFailed(reservation: ProcessReservation, disposition: string): Result<void> {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(disposition)) {
        return failure("PROCESS_DISPOSITION_INVALID", "Process disposition is invalid.");
      }
      try {
        const changed = database
          .query(
            `UPDATE local_processes SET state = 'FAILED_TO_START', last_disposition = ?, updated_at = ?
             WHERE reservation_id = ? AND state = 'RESERVED'`,
          )
          .run(disposition, clock(), reservation.reservationId);
        return changed.changes === 1
          ? { ok: true, value: undefined }
          : failure("PROCESS_STATE_CONFLICT", "Local process state changed.");
      } catch {
        return failure("PROCESS_STATE_FAILED", "Local process state failed.");
      }
    },

    recordStarted(reservation: ProcessReservation, identity: HostProcess): Result<void> {
      try {
        const changed = database
          .query(
            `UPDATE local_processes SET state = 'STARTED', host = ?, opaque_process_id = ?,
               interaction = ?, assurance = ?, updated_at = ?
             WHERE reservation_id = ? AND state = 'RESERVED'`,
          )
          .run(
            identity.host,
            identity.opaqueProcessId,
            identity.interaction,
            identity.assurance,
            clock(),
            reservation.reservationId,
          );
        return changed.changes === 1
          ? { ok: true, value: undefined }
          : failure("PROCESS_STATE_CONFLICT", "Local process state changed.");
      } catch {
        return failure("PROCESS_STATE_FAILED", "Local process state failed.");
      }
    },

    inspect(attemptId: string): Result<
      Readonly<{
        state: "RESERVED" | "STARTED" | "FAILED_TO_START" | "EXITED" | "UNKNOWN";
        assignmentDigest: string;
        opaqueProcessId: string | null;
      }>
    > {
      const row = database
        .query<
          {
            state: "RESERVED" | "STARTED" | "FAILED_TO_START" | "EXITED" | "UNKNOWN";
            assignment_digest: string;
            opaque_process_id: string | null;
          },
          [string]
        >(
          "SELECT state, assignment_digest, opaque_process_id FROM local_processes WHERE attempt_id = ?",
        )
        .get(attemptId);
      return row
        ? {
            ok: true,
            value: {
              state: row.state,
              assignmentDigest: row.assignment_digest,
              opaqueProcessId: row.opaque_process_id,
            },
          }
        : failure("PROCESS_NOT_FOUND", "Local process was not found.");
    },
  };
}
