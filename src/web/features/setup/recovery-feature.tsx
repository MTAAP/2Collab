import { useState } from "react";
import { z } from "zod";
import { browserJson } from "../../api-client.ts";
import { authClient } from "../../auth-client.ts";

const RecoveryCompleteSchema = z.object({
  ok: z.literal(true),
  value: z.object({ memberId: z.string(), readyToSignIn: z.literal(true) }),
});

let capturedRegistrationContext: string | undefined;

function takeRegistrationContext(): string {
  if (capturedRegistrationContext !== undefined) return capturedRegistrationContext;
  const fragment = window.location.hash.slice(1);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  if (!fragment) {
    capturedRegistrationContext = "";
    return capturedRegistrationContext;
  }
  try {
    const keyed = new URLSearchParams(fragment).get("registrationContext");
    capturedRegistrationContext = keyed ?? decodeURIComponent(fragment);
  } catch {
    capturedRegistrationContext = "";
  }
  return capturedRegistrationContext;
}

export function RecoveryFeature() {
  const [registrationContext] = useState(takeRegistrationContext);
  const [state, setState] = useState<"READY" | "WORKING" | "FAILED">("READY");
  const [phase, setPhase] = useState<"REGISTER" | "COMPLETE" | "SIGN_IN">("REGISTER");
  const [error, setError] = useState<string>();

  async function recover(form: FormData) {
    setState("WORKING");
    setError(undefined);
    try {
      if (registrationContext.length < 32) throw new Error("RECOVERY_CONTEXT_INVALID");
      if (phase === "REGISTER") {
        const registration = await authClient.passkey.addPasskey({
          name: String(form.get("credentialName") ?? ""),
          context: registrationContext,
        });
        if (registration.error)
          throw new Error(registration.error.message ?? "PASSKEY_REGISTRATION_FAILED");
        setPhase("COMPLETE");
      }
      if (phase !== "SIGN_IN") {
        await browserJson("/api/v1/auth/recovery/complete", RecoveryCompleteSchema, {
          method: "POST",
          body: JSON.stringify({ registrationContext }),
        });
        setPhase("SIGN_IN");
      }
      const signIn = await authClient.signIn.passkey();
      if (signIn.error) throw new Error(signIn.error.message ?? "PASSKEY_SIGN_IN_FAILED");
      window.location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "RECOVERY_FAILED");
      setState("FAILED");
    }
  }

  return (
    <main className="setup-page">
      <header className="setup-header">
        <strong>Collab</strong>
        <span>Host recovery</span>
      </header>
      <div className="setup-layout">
        <section className="setup-panel">
          <p className="utility">RESTORE ACCESS</p>
          <h1>Register a replacement passkey</h1>
          <p>Use the one-time recovery link created on the Collab host.</p>
          {!registrationContext ? (
            <p role="alert" className="error-text">
              This recovery link is missing its one-time registration context.
            </p>
          ) : (
            <form action={(form) => void recover(form)}>
              <label>
                Passkey name
                <input
                  name="credentialName"
                  defaultValue="Recovery passkey"
                  required
                  disabled={phase !== "REGISTER"}
                />
              </label>
              {error ? (
                <p role="alert" className="error-text">
                  {error}
                </p>
              ) : null}
              <button type="submit" className="primary-button" disabled={state === "WORKING"}>
                {state === "WORKING"
                  ? "Working…"
                  : phase === "COMPLETE"
                    ? "Retry recovery completion"
                    : phase === "SIGN_IN"
                      ? "Retry sign in"
                      : "Register replacement passkey"}
              </button>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
