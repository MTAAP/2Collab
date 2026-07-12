import { useState } from "react";
import { z } from "zod";
import { browserJson } from "../../api-client.ts";
import { authenticationOptions, serializeAuthenticationCredential } from "./webauthn.ts";

const Challenge = z.object({
  ok: z.literal(true),
  value: z.object({ challengeId: z.string(), options: z.record(z.string(), z.unknown()) }),
});
const Session = z.object({
  ok: z.literal(true),
  value: z.object({ memberId: z.string(), expiresAt: z.number(), csrfProof: z.string() }),
});

function safeReturnTo(): string {
  const value = new URLSearchParams(window.location.search).get("returnTo");
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/runs";
}

export function LoginFeature() {
  const [state, setState] = useState<"READY" | "WORKING" | "FAILED">("READY");
  return (
    <main className="setup-page">
      <header className="setup-header">
        <strong>Collab</strong>
        <span>Sign in</span>
      </header>
      <div className="setup-layout">
        <section className="setup-panel">
          <p className="utility">TEAM ACCESS</p>
          <h1>Sign in with your passkey</h1>
          <p>Authenticate to restore mutation authority in this browser tab.</p>
          {state === "FAILED" ? <p role="alert">Passkey sign-in failed.</p> : null}
          <button
            type="button"
            className="primary-button"
            disabled={state === "WORKING"}
            onClick={async () => {
              setState("WORKING");
              try {
                const challenge = await browserJson(
                  "/api/v1/auth/passkeys/authentication/begin",
                  Challenge,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      idempotencyKey: `passkey_begin_${crypto.randomUUID().replaceAll("-", "")}`,
                    }),
                  },
                );
                const credential = await navigator.credentials.get({
                  publicKey: authenticationOptions(challenge.value.options),
                });
                if (!(credential instanceof PublicKeyCredential))
                  throw new Error("PASSKEY_CANCELLED");
                const session = await browserJson(
                  "/api/v1/auth/passkeys/authentication/finish",
                  Session,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      idempotencyKey: `passkey_finish_${crypto.randomUUID().replaceAll("-", "")}`,
                      challengeId: challenge.value.challengeId,
                      response: serializeAuthenticationCredential(credential),
                    }),
                  },
                );
                sessionStorage.setItem("collab_csrf", session.value.csrfProof);
                window.location.assign(safeReturnTo());
              } catch {
                setState("FAILED");
              }
            }}
          >
            {state === "WORKING" ? "Signing in…" : "Use passkey"}
          </button>
        </section>
      </div>
    </main>
  );
}
