import { useState } from "react";
import { z } from "zod";
import { browserJson } from "../../api-client.ts";

const Approval = z.object({
  ok: z.literal(true),
  value: z.object({
    deviceCodeId: z.string(),
    state: z.literal("APPROVED"),
    revision: z.number().int().positive(),
  }),
});

export function DeviceAuthorization({ deviceCodeId }: Readonly<{ deviceCodeId: string }>) {
  const [state, setState] = useState<"READY" | "WORKING" | "APPROVED" | "FAILED">("READY");
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
          {!sessionStorage.getItem("collab_csrf") ? (
            <p>
              <a href={`/login?returnTo=${encodeURIComponent(window.location.pathname)}`}>
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
                disabled={state === "WORKING"}
                onClick={async () => {
                  setState("WORKING");
                  try {
                    await browserJson(
                      `/api/v1/device/authorization/${encodeURIComponent(deviceCodeId)}/approve`,
                      Approval,
                      {
                        method: "POST",
                        body: JSON.stringify({
                          idempotencyKey: `device_approve_${crypto.randomUUID().replaceAll("-", "")}`,
                        }),
                      },
                    );
                    setState("APPROVED");
                  } catch {
                    setState("FAILED");
                  }
                }}
              >
                {state === "FAILED" ? "Retry authorization" : "Authorize device"}
              </button>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
