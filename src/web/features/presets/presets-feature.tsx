export function PresetsFeature() {
  return (
    <>
      <header className="workspace-header">
        <div>
          <p className="utility">PERSONAL CONFIGURATION</p>
          <h1>Personal Run Presets</h1>
          <p>Reusable visible choices with immutable versioned bindings.</p>
        </div>
        <button type="button" className="primary-button">
          New preset
        </button>
      </header>
      <section className="preset-grid">
        <article className="preset-card">
          <span className="utility">DEFAULT</span>
          <h2>Foundation inspect</h2>
          <p>Source-free inspection with bounded context and one attempt.</p>
          <dl>
            <div>
              <dt>Runtime</dt>
              <dd>Codex</dd>
            </div>
            <div>
              <dt>Authority</dt>
              <dd>Inspect only · Advisory</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>v1</dd>
            </div>
          </dl>
          <footer>Historical runs keep this exact version.</footer>
        </article>
      </section>
    </>
  );
}
