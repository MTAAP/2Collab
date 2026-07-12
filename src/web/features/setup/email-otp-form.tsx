import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { browserJson } from "../../api-client.ts";

const Requested = z.object({
  ok: z.literal(true),
  value: z.union([
    z.object({ accepted: z.literal(true) }),
    z.object({ expiresAt: z.number(), resendAt: z.number() }),
  ]),
});
const Verified = z.object({
  ok: z.literal(true),
  value: z.union([
    z.object({ authenticated: z.literal(true) }),
    z.object({ enrolled: z.literal(true) }),
  ]),
});

export function EmailOtpForm(
  props: Readonly<{
    requestPath: string;
    verifyPath: string;
    requestFields?: Readonly<Record<string, string>>;
    collectDisplayName?: boolean;
    verifyLabel?: string;
    onSuccess: () => void;
  }>,
) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [otp, setOtp] = useState("");
  const [phase, setPhase] = useState<"EMAIL" | "SENDING" | "OTP" | "VERIFYING">("EMAIL");
  const [verificationFailed, setVerificationFailed] = useState(false);
  const [status, setStatus] = useState<string>();
  const otpRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (phase === "OTP") otpRef.current?.focus();
  }, [phase]);

  async function requestCode() {
    setPhase("SENDING");
    setStatus(undefined);
    try {
      await browserJson(props.requestPath, Requested, {
        method: "POST",
        body: JSON.stringify({
          email,
          ...(props.collectDisplayName ? { displayName } : {}),
          ...props.requestFields,
        }),
      });
      setOtp("");
      setVerificationFailed(false);
      setStatus("If this address is eligible, a new six-digit code has been sent.");
      setPhase("OTP");
    } catch {
      setStatus("Unable to request a code right now. Try again.");
      setPhase("EMAIL");
    }
  }

  async function verifyCode() {
    setPhase("VERIFYING");
    setStatus(undefined);
    try {
      await browserJson(props.verifyPath, Verified, {
        method: "POST",
        body: JSON.stringify({ email, otp }),
      });
      props.onSuccess();
    } catch {
      setVerificationFailed(true);
      setStatus("The code could not be verified. Check it or retry.");
      setPhase("OTP");
    }
  }

  return phase === "EMAIL" || phase === "SENDING" ? (
    <form
      action={() => void requestCode()}
      aria-busy={phase === "SENDING"}
      className="email-otp-form"
    >
      <label>
        Email address
        <input
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
          required
        />
      </label>
      {props.collectDisplayName ? (
        <label>
          Your name
          <input
            name="displayName"
            autoComplete="name"
            value={displayName}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            required
            minLength={1}
            maxLength={120}
          />
        </label>
      ) : null}
      {status ? <p role="alert">{status}</p> : null}
      <button type="submit" className="primary-button" disabled={phase === "SENDING"}>
        {phase === "SENDING" ? "Sending…" : "Send code"}
      </button>
    </form>
  ) : (
    <form
      action={() => void verifyCode()}
      aria-busy={phase === "VERIFYING"}
      className="email-otp-form"
    >
      <label>
        Six-digit code
        <input
          ref={otpRef}
          name="otp"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          value={otp}
          onChange={(event) => setOtp(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
          required
        />
      </label>
      <p aria-live="polite">{status}</p>
      <button type="submit" className="primary-button" disabled={phase === "VERIFYING"}>
        {phase === "VERIFYING"
          ? "Verifying…"
          : verificationFailed
            ? "Retry verification"
            : (props.verifyLabel ?? "Verify code")}
      </button>
      <button type="button" disabled={phase === "VERIFYING"} onClick={() => void requestCode()}>
        Send a new code
      </button>
    </form>
  );
}
