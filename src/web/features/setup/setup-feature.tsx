import { useState } from "react";
import { z } from "zod";
import { browserJson } from "../../api-client.ts";
import { authClient } from "../../auth-client.ts";

const BootstrapBeginSchema = z.object({
  ok: z.literal(true),
  value: z.object({
    registrationContext: z.string(),
    memberId: z.string(),
    expiresAt: z.number(),
  }),
});
const BootstrapCompleteSchema = z.object({
  ok: z.literal(true),
  value: z.object({ memberId: z.string(), readyToSignIn: z.literal(true) }),
});

export function SetupFeature() {
  const [state, setState] = useState<"FORM" | "WORKING" | "READY">("FORM");
  const [phase, setPhase] = useState<"REGISTER" | "COMPLETE" | "SIGN_IN">("REGISTER");
  const [registrationContext, setRegistrationContext] = useState<string>();
  const [error, setError] = useState<string>();
  async function submit(form: FormData) {
    setState("WORKING");
    setError(undefined);
    const bootstrapSecret = String(form.get("bootstrapSecret") ?? "");
    const displayName = String(form.get("displayName") ?? "");
    const credentialName = String(form.get("credentialName") ?? "");
    try {
      let context = registrationContext;
      if (phase === "REGISTER") {
        const bootstrap = await browserJson("/api/v1/bootstrap/auth/begin", BootstrapBeginSchema, {
          method: "POST",
          body: JSON.stringify({ bootstrapSecret, displayName }),
        });
        context = bootstrap.value.registrationContext;
        const registration = await authClient.passkey.addPasskey({ name: credentialName, context });
        if (registration.error)
          throw new Error(registration.error.message ?? "PASSKEY_REGISTRATION_FAILED");
        setRegistrationContext(context);
        setPhase("COMPLETE");
      }
      if (phase !== "SIGN_IN") {
        if (!context) throw new Error("REGISTRATION_CONTEXT_INVALID");
        await browserJson("/api/v1/bootstrap/auth/complete", BootstrapCompleteSchema, {
          method: "POST",
          body: JSON.stringify({ registrationContext: context }),
        });
        setPhase("SIGN_IN");
      }
      const signIn = await authClient.signIn.passkey();
      if (signIn.error) throw new Error(signIn.error.message ?? "PASSKEY_SIGN_IN_FAILED");
      setState("READY");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "SETUP_FAILED");
      setState("FORM");
    }
  }
  return (
    <main className="setup-page">
      <header className="setup-header">
        <strong>Collab</strong>
        <span>First-run setup</span>
      </header>
      <div className="setup-layout">
        <ol className="setup-progress">
          <li className="active">
            1{" "}
            <span>
              Secure deployment<small>Create the first owner</small>
            </span>
          </li>
          <li>
            2 <span>Create your team</span>
          </li>
          <li>
            3 <span>Connect sources</span>
          </li>
          <li>
            4 <span>Install a runner</span>
          </li>
          <li>
            5 <span>Ready</span>
          </li>
        </ol>
        <section className="setup-panel">
          {state === "READY" ? (
            <>
              <p className="utility">SETUP COMPLETE</p>
              <h1>Your team is ready</h1>
              <p>The owner passkey is registered and this browser is signed in.</p>
              <a className="primary-button" href="/runs">
                Open Collab
              </a>
            </>
          ) : (
            <>
              <p className="utility">STEP 1 OF 5</p>
              <h1>Secure your deployment</h1>
              <p>Use the one-time bootstrap secret and register the first owner passkey.</p>
              <form action={(form) => void submit(form)}>
                <label>
                  Bootstrap secret
                  <input
                    name="bootstrapSecret"
                    minLength={32}
                    required
                    autoComplete="off"
                    disabled={phase !== "REGISTER"}
                  />
                </label>
                <label>
                  Your name
                  <input name="displayName" required disabled={phase !== "REGISTER"} />
                </label>
                <label>
                  Passkey name
                  <input
                    name="credentialName"
                    defaultValue="This device"
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
                      ? "Retry setup completion"
                      : phase === "SIGN_IN"
                        ? "Retry sign in"
                        : "Register passkey"}
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
