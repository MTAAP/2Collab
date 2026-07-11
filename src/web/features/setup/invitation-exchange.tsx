import { useLayoutEffect, useState } from "react";
import { z } from "zod";
import { browserJson } from "../../api-client.ts";

const ExchangeSchema = z.object({
  ok: z.literal(true),
  value: z.object({ invitationId: z.string(), expiresAt: z.number() }),
});

export function InvitationExchange() {
  const [state, setState] = useState<"EXCHANGING" | "READY" | "FAILED">("EXCHANGING");
  useLayoutEffect(() => {
    const secret = window.location.hash.slice(1);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    if (secret.length < 32) {
      setState("FAILED");
      return;
    }
    void browserJson("/api/v1/invitations/exchange", ExchangeSchema, {
      method: "POST",
      body: JSON.stringify({ secret, idempotencyKey: crypto.randomUUID() }),
    }).then(
      () => setState("READY"),
      () => setState("FAILED"),
    );
  }, []);
  return (
    <main className="join-page">
      <section className="join-panel">
        <strong>Collab</strong>
        <h1>
          {state === "READY"
            ? "Join Foundation team"
            : state === "FAILED"
              ? "Invitation unavailable"
              : "Checking invitation…"}
        </h1>
        {state === "READY" ? (
          <>
            <p>
              You are joining as a Member. Register a passkey or choose an enabled provider to
              continue.
            </p>
            <button type="button" className="primary-button">
              Register a passkey
            </button>
          </>
        ) : null}
      </section>
    </main>
  );
}
