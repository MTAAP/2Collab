import { useEffect, useState } from "react";
import { authClient } from "../../auth-client.ts";

export function DeviceAuthorization({ userCode }: Readonly<{ userCode: string }>) {
  const session = authClient.useSession();
  const [state, setState] = useState<"CLAIMING" | "READY" | "WORKING" | "APPROVED" | "FAILED">(
    "CLAIMING",
  );
  const returnTo = `/device?user_code=${encodeURIComponent(userCode)}`;

  async function claim(): Promise<boolean> {
    const result = await authClient.device({ query: { user_code: userCode } });
    if (result.error) return false;
    if (result.data.status === "approved") {
      setState("APPROVED");
      return false;
    }
    return result.data.status === "pending";
  }

  useEffect(() => {
    if (session.isPending) return;
    if (!session.data) {
      setState("READY");
      return;
    }
    let active = true;
    void authClient.device({ query: { user_code: userCode } }).then((result) => {
      if (!active) return;
      setState(result.error ? "FAILED" : result.data.status === "approved" ? "APPROVED" : "READY");
    });
    return () => {
      active = false;
    };
  }, [session.data, session.isPending, userCode]);

  return (
    <main className="setup-page">
      <header className="setup-header">
        <strong>Collab</strong>
        <span>CLI authorization</span>
      </header>
      <div className="setup-layout">
        <section className="setup-panel">
          <p className="utility">TRUSTED DEVICE</p>
          <h1>Authorize this CLI device?</h1>
          <p>Continue only if you started device enrollment on the Mac Studio.</p>
          {!session.isPending && !session.data ? (
            <p>
              <a href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>
                Sign in with your passkey first
              </a>
            </p>
          ) : null}
          {state === "APPROVED" ? (
            <p>CLI device authorized. Return to the Mac Studio to complete enrollment.</p>
          ) : (
            <>
              {state === "FAILED" ? <p role="alert">Device authorization failed.</p> : null}
              <button
                type="button"
                className="primary-button"
                disabled={state === "WORKING" || state === "CLAIMING" || !session.data}
                onClick={async () => {
                  setState("WORKING");
                  try {
                    if (!(await claim())) throw new Error("DEVICE_CLAIM_FAILED");
                    const approval = await authClient.device.approve({
                      userCode,
                    });
                    if (approval.error || !approval.data.success)
                      throw new Error("DEVICE_AUTHORIZATION_FAILED");
                    setState("APPROVED");
                  } catch {
                    setState("FAILED");
                  }
                }}
              >
                {state === "CLAIMING"
                  ? "Checking device…"
                  : state === "FAILED"
                    ? "Retry authorization"
                    : "Authorize device"}
              </button>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
