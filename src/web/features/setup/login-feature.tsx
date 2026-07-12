import { useState } from "react";
import { authClient } from "../../auth-client.ts";
import { EmailOtpForm } from "./email-otp-form.tsx";

function safeReturnTo(): string {
  const value = new URLSearchParams(window.location.search).get("returnTo");
  if (!value?.startsWith("/") || value.startsWith("//")) return "/runs";
  const candidate = new URL(value, window.location.origin);
  return candidate.origin === window.location.origin
    ? `${candidate.pathname}${candidate.search}`
    : "/runs";
}

export function LoginFeature() {
  const [state, setState] = useState<"READY" | "WORKING" | "FAILED">("READY");
  const [method, setMethod] = useState<"PASSKEY" | "EMAIL">("PASSKEY");
  return (
    <main className="setup-page">
      <header className="setup-header">
        <strong>Collab</strong>
        <span>Sign in</span>
      </header>
      <div className="setup-layout">
        <section className="setup-panel">
          <p className="utility">TEAM ACCESS</p>
          <h1>Sign in to Collab</h1>
          <p>Authenticate to securely access your team in this browser.</p>
          <fieldset>
            <legend>Sign-in method</legend>
            <label>
              <input
                type="radio"
                name="method"
                checked={method === "PASSKEY"}
                onChange={() => setMethod("PASSKEY")}
              />
              Passkey
            </label>
            <label>
              <input
                type="radio"
                name="method"
                checked={method === "EMAIL"}
                onChange={() => setMethod("EMAIL")}
              />
              Email code
            </label>
          </fieldset>
          {method === "EMAIL" ? (
            <EmailOtpForm
              requestPath="/api/v1/auth/email-otp/request"
              verifyPath="/api/v1/auth/email-otp/verify"
              collectDisplayName
              onSuccess={() => window.location.assign(safeReturnTo())}
            />
          ) : (
            <>
              {state === "FAILED" ? <p role="alert">Passkey sign-in failed.</p> : null}
              <button
                type="button"
                className="primary-button"
                disabled={state === "WORKING"}
                onClick={async () => {
                  setState("WORKING");
                  try {
                    const session = await authClient.signIn.passkey();
                    if (session.error)
                      throw new Error(session.error.message ?? "PASSKEY_SIGN_IN_FAILED");
                    window.location.assign(safeReturnTo());
                  } catch {
                    setState("FAILED");
                  }
                }}
              >
                {state === "WORKING" ? "Signing in…" : "Use passkey"}
              </button>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
