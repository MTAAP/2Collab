import type { Result } from "../../../shared/contracts/result.ts";
import type { RepositoryEnforcementAdapter } from "../../execution-contract.ts";

function failure<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function createTrustedHostEnforcement(
  dependencies: Readonly<{ id: () => string }>,
): RepositoryEnforcementAdapter {
  const sessions = new Map<string, "ACTIVE" | "REVOKED">();
  return {
    assurance: "ADVISORY",
    async activate(input) {
      if (
        input.assurance !== "ADVISORY" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.worktree.id)
      ) {
        return failure("ASSURANCE_UNAVAILABLE", "Requested repository assurance is unavailable.");
      }
      const sessionId = dependencies.id();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId) || sessions.has(sessionId)) {
        return failure("ENFORCEMENT_SESSION_FAILED", "Repository enforcement could not start.");
      }
      sessions.set(sessionId, "ACTIVE");
      return { ok: true, value: { sessionId } };
    },
    async inspect(sessionId) {
      const state = sessions.get(sessionId);
      return state
        ? { ok: true, value: { state, assurance: "ADVISORY" as const } }
        : failure("ENFORCEMENT_SESSION_NOT_FOUND", "Repository enforcement session was not found.");
    },
    async revoke(sessionId) {
      if (!sessions.has(sessionId)) {
        return failure(
          "ENFORCEMENT_SESSION_NOT_FOUND",
          "Repository enforcement session was not found.",
        );
      }
      sessions.set(sessionId, "REVOKED");
      return { ok: true, value: undefined };
    },
  };
}
