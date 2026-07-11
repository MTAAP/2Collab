export function RunnersFeature() {
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
