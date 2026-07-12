import { useEffect, useState } from "react";
import { PublicRunOperationResultSchema } from "../../../shared/contracts/public-api.ts";
import { browserJson } from "../../api-client.ts";
import { subscribeToProjections } from "../../projection-client.ts";

export function RunsFeature() {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string>();
  const [live, setLive] = useState("Waiting for committed updates");
  useEffect(() => {
    return subscribeToProjections((message) => {
      if (message.kind === "RESET") setLive("Projection refreshed");
      else setLive(`Committed update ${message.cursor}`);
    });
  }, []);
  async function create(form: FormData) {
    const response = await browserJson("/api/v1/runs", PublicRunOperationResultSchema, {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        projectId: "project_1",
        coordination: {
          kind: "NEW",
          title: String(form.get("title")),
          sourceRefs: [],
        },
        goal: String(form.get("goal")),
        repository: { repositoryId: String(form.get("repository")) },
        preset: { presetId: String(form.get("preset")), presetVersion: 1 },
      }),
    });
    setResult(
      response.ok && response.value.kind === "CREATE_RUN"
        ? response.value.run.id
        : response.ok
          ? "RESPONSE_INVALID"
          : response.error.code,
    );
    if (response.ok && response.value.kind === "CREATE_RUN") setOpen(false);
  }
  return (
    <>
      <header className="workspace-header">
        <div>
          <p className="utility">RUNS</p>
          <h1>Agent runs</h1>
          <p>Durable goals with explicit execution and authority.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setOpen(true)}>
          New run
        </button>
      </header>
      <section className="summary-grid">
        <article>
          <span>ACTIVE</span>
          <strong>0</strong>
          <small>{live}</small>
        </article>
        <article>
          <span>WAITING</span>
          <strong>0</strong>
          <small>Needs a human decision</small>
        </article>
        <article>
          <span>COMPLETED</span>
          <strong>{result ? 1 : 0}</strong>
          <small>Committed history</small>
        </article>
      </section>
      <section className="data-panel">
        <header>
          <strong>Recent runs</strong>
        </header>
        {result ? (
          <div className="data-row">
            <div>
              <strong>{result}</strong>
              <small>Queued from Personal Run Preset</small>
            </div>
            <span className="status">QUEUED</span>
          </div>
        ) : (
          <div className="empty-state">No runs yet. Create one from a Personal Run Preset.</div>
        )}
      </section>
      {open ? (
        <div className="modal-backdrop">
          <section
            className="run-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-run-title"
          >
            <header>
              <div>
                <h2 id="new-run-title">New run</h2>
                <p>Create one durable goal with explicit context and authority.</p>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </header>
            <form action={(form) => void create(form)}>
              <label>
                Run goal
                <textarea
                  name="goal"
                  required
                  defaultValue="Implement the bounded Foundation slice."
                />
              </label>
              <div className="form-grid">
                <label>
                  Record title
                  <input name="title" required defaultValue="Foundation work" />
                </label>
                <label>
                  Repository
                  <input name="repository" required defaultValue="repository_1" />
                </label>
                <label>
                  Personal Run Preset
                  <input name="preset" required defaultValue="preset_1" />
                </label>
              </div>
              <aside className="configuration-note">
                <span>EFFECTIVE CONFIGURATION</span>
                <p>Preset version, profile, bounds, and context are snapshotted at launch.</p>
              </aside>
              <button type="submit" className="primary-button">
                Launch run
              </button>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}
