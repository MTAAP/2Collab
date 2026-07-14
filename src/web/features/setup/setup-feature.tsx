import { useState } from "react";
import { z } from "zod";
import { browserJson } from "../../api-client.ts";
import { registrationOptions, serializeCredential } from "./webauthn.ts";

const ChallengeSchema = z.object({
  ok: z.literal(true),
  value: z.object({ challengeId: z.string(), options: z.record(z.string(), z.unknown()) }),
});
const SessionSchema = z.object({
  ok: z.literal(true),
  value: z.object({ memberId: z.string(), csrfProof: z.string() }),
});

export function SetupFeature() {
  const [state, setState] = useState<"FORM" | "WORKING" | "READY">("FORM");
  const [error, setError] = useState<string>();
  async function submit(form: FormData) {
    setState("WORKING");
    setError(undefined);
    const bootstrapSecret = String(form.get("bootstrapSecret") ?? "");
    const displayName = String(form.get("displayName") ?? "");
    const credentialName = String(form.get("credentialName") ?? "");
    try {
      const challenge = await browserJson(
        "/api/v1/auth/passkeys/registration/begin",
        ChallengeSchema,
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: crypto.randomUUID(),
            bootstrapSecret,
            displayName,
          }),
        },
      );
      const credential = await navigator.credentials.create({
        publicKey: registrationOptions(challenge.value.options),
      });
      if (!(credential instanceof PublicKeyCredential)) throw new Error("PASSKEY_CANCELLED");
      const session = await browserJson("/api/v1/bootstrap", SessionSchema, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          bootstrapSecret,
          displayName,
          credentialName,
          challengeId: challenge.value.challengeId,
          response: serializeCredential(credential),
        }),
      });
      sessionStorage.setItem("collab_csrf", session.value.csrfProof);
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
              <p>The owner passkey is registered and the deployment is claimed.</p>
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
                  <input name="bootstrapSecret" minLength={32} required autoComplete="off" />
                </label>
                <label>
                  Your name
                  <input name="displayName" required />
                </label>
                <label>
                  Passkey name
                  <input name="credentialName" defaultValue="This device" required />
                </label>
                {error ? (
                  <p role="alert" className="error-text">
                    {error}
                  </p>
                ) : null}
                <button type="submit" className="primary-button" disabled={state === "WORKING"}>
                  {state === "WORKING" ? "Registering…" : "Register passkey"}
                </button>
              </form>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
