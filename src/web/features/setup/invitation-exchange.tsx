import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { browserJson } from "../../api-client.ts";
import { authClient } from "../../auth-client.ts";
import { EmailOtpForm } from "./email-otp-form.tsx";

const Invitation = z.object({
  id: z.string(),
  inviterDisplayName: z.string(),
  role: z.literal("MEMBER"),
  expiresAt: z.number(),
});
const ExchangeSchema = z.object({
  ok: z.literal(true),
  value: z.object({ invitationId: z.string(), expiresAt: z.number(), invitation: Invitation }),
});
const BeginSchema = z.object({
  ok: z.literal(true),
  value: z.object({
    registrationContext: z.string(),
    memberId: z.string(),
    expiresAt: z.number(),
    invitation: Invitation,
  }),
});
const CompleteSchema = z.object({
  ok: z.literal(true),
  value: z.object({ memberId: z.string(), readyToSignIn: z.literal(true) }),
});
type InvitationView = z.infer<typeof Invitation>;

let capturedInvitationSecret: string | undefined;

function takeInvitationSecret(): string {
  if (capturedInvitationSecret !== undefined) return capturedInvitationSecret;
  const fragment = window.location.hash.slice(1);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  try {
    capturedInvitationSecret = decodeURIComponent(fragment);
  } catch {
    capturedInvitationSecret = "";
  }
  return capturedInvitationSecret;
}

export function InvitationExchange() {
  const [secret] = useState(takeInvitationSecret);
  const started = useRef(false);
  const [state, setState] = useState<"EXCHANGING" | "READY" | "WORKING" | "FAILED">("EXCHANGING");
  const [invitation, setInvitation] = useState<InvitationView>();
  const [phase, setPhase] = useState<"REGISTER" | "COMPLETE" | "SIGN_IN">("REGISTER");
  const [registrationContext, setRegistrationContext] = useState<string>();
  const [error, setError] = useState<string>();
  const [method, setMethod] = useState<"PASSKEY" | "EMAIL">("PASSKEY");
  const [emailDisplayName, setEmailDisplayName] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (secret.length < 32) {
      setState("FAILED");
      return;
    }
    void browserJson("/api/v1/invitations/exchange", ExchangeSchema, {
      method: "POST",
      body: JSON.stringify({ secret, idempotencyKey: crypto.randomUUID() }),
    }).then(
      (result) => {
        setInvitation(result.value.invitation);
        setState("READY");
      },
      () => setState("FAILED"),
    );
  }, [secret]);

  async function join(form: FormData) {
    setState("WORKING");
    setError(undefined);
    try {
      const displayName = String(form.get("displayName") ?? "");
      const credentialName = String(form.get("credentialName") ?? "");
      let context = registrationContext;
      if (phase === "REGISTER") {
        const begun = await browserJson("/api/v1/invitations/auth/begin", BeginSchema, {
          method: "POST",
          body: JSON.stringify({ displayName }),
        });
        context = begun.value.registrationContext;
        const registration = await authClient.passkey.addPasskey({
          name: credentialName,
          context,
        });
        if (registration.error)
          throw new Error(registration.error.message ?? "PASSKEY_REGISTRATION_FAILED");
        setRegistrationContext(context);
        setPhase("COMPLETE");
      }
      if (phase !== "SIGN_IN") {
        if (!context) throw new Error("REGISTRATION_CONTEXT_INVALID");
        await browserJson("/api/v1/invitations/auth/complete", CompleteSchema, {
          method: "POST",
          body: JSON.stringify({ registrationContext: context }),
        });
        setPhase("SIGN_IN");
      }
      const signIn = await authClient.signIn.passkey();
      if (signIn.error) throw new Error(signIn.error.message ?? "PASSKEY_SIGN_IN_FAILED");
      window.location.assign("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "INVITATION_AUTH_FAILED");
      setState("READY");
    }
  }

  return (
    <main className="join-page">
      <section className="join-panel">
        <strong>Collab</strong>
        <h1>
          {state === "READY" || state === "WORKING"
            ? "Join Foundation team"
            : state === "FAILED"
              ? "Invitation unavailable"
              : "Checking invitation…"}
        </h1>
        {invitation ? (
          <>
            <p>Invited by {invitation.inviterDisplayName}</p>
            <p>Role: Member</p>
            <p>Invitation expires {new Date(invitation.expiresAt * 1_000).toLocaleString()}.</p>
            <p>Authenticate before your membership is created.</p>
            <fieldset>
              <legend>Join with</legend>
              <label>
                <input
                  type="radio"
                  name="join-method"
                  checked={method === "PASSKEY"}
                  onChange={() => setMethod("PASSKEY")}
                />
                Passkey
              </label>
              <label>
                <input
                  type="radio"
                  name="join-method"
                  checked={method === "EMAIL"}
                  onChange={() => setMethod("EMAIL")}
                />
                Email code
              </label>
            </fieldset>
            {method === "EMAIL" ? (
              <>
                <label>
                  Your name
                  <input
                    value={emailDisplayName}
                    onChange={(event) => setEmailDisplayName(event.currentTarget.value)}
                    required
                  />
                </label>
                <EmailOtpForm
                  requestPath="/api/v1/invitations/auth/email-otp/request"
                  verifyPath="/api/v1/invitations/auth/email-otp/verify"
                  requestFields={{ displayName: emailDisplayName }}
                  verifyLabel="Verify code and join"
                  onSuccess={() => window.location.assign("/")}
                />
              </>
            ) : (
              <form action={(form) => void join(form)}>
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
                      ? "Retry invitation completion"
                      : phase === "SIGN_IN"
                        ? "Retry sign in"
                        : "Register passkey and join"}
                </button>
              </form>
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}
