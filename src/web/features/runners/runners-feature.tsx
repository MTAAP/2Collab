import { useState } from "react";
import { z } from "zod";
import { browserJson } from "../../api-client.ts";

const PairingResult = z.object({
  ok: z.literal(true),
  value: z.object({ pairingId: z.string(), confirmedAt: z.number() }),
});

export function RunnersFeature() {
  const pairingId = /^\/runners\/pairing\/([A-Za-z0-9_-]{1,128})$/.exec(
    window.location.pathname,
  )?.[1];
  const [pairingState, setPairingState] = useState<"READY" | "CONFIRMING" | "CONFIRMED" | "FAILED">(
    "READY",
  );
  if (pairingId)
    return (
      <>
        <header className="workspace-header">
          <div>
            <p className="utility">COLLAB / RUNNERS / PAIR</p>
            <h1>Pair this trusted machine?</h1>
            <p>Confirm only if you started this pairing from your local Collab CLI.</p>
          </div>
        </header>
        <section className="data-panel">
          <div className="empty-state">
            {pairingState === "CONFIRMED" ? (
              "Runner pairing confirmed. Return to the terminal and complete installation."
            ) : (
              <button
                type="button"
                className="primary-button"
                disabled={pairingState === "CONFIRMING"}
                onClick={async () => {
                  setPairingState("CONFIRMING");
                  try {
                    await browserJson(
                      `/api/v1/runners/pairing/${encodeURIComponent(pairingId)}/confirm`,
                      PairingResult,
                      {
                        method: "POST",
                        body: JSON.stringify({
                          idempotencyKey: `runner_confirm_${crypto.randomUUID().replaceAll("-", "")}`,
                        }),
                      },
                    );
                    setPairingState("CONFIRMED");
                  } catch {
                    setPairingState("FAILED");
                  }
                }}
              >
                {pairingState === "FAILED" ? "Retry confirmation" : "Confirm runner pairing"}
              </button>
            )}
          </div>
        </section>
      </>
    );
  return (
    <>
      <header className="workspace-header">
        <div>
          <p className="utility">COLLAB / RUNNERS</p>
          <h1>Runner fleet</h1>
          <p>Trusted machines execute locally; owners decide who may dispatch.</p>
        </div>
        <button type="button" className="primary-button">
          Pair runner
        </button>
      </header>
      <section className="runner-grid">
        <article className="runner-card">
          <header>
            <span className="machine-icon">▣</span>
            <div>
              <strong>No paired runners</strong>
              <small>Pair a trusted machine to launch work.</small>
            </div>
          </header>
          <div className="compatibility">
            <span>EXECUTION COMPATIBILITY</span>
            <p>Profiles reveal capabilities, never commands or local paths.</p>
          </div>
        </article>
      </section>
      <section className="data-panel">
        <header>
          <strong>Profiles and dispatch exposure</strong>
        </header>
        <div className="empty-state">No launch profiles are visible.</div>
      </section>
    </>
  );
}
