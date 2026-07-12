import type { WorkflowDiagnostic } from "../../../server/modules/workflows/validation.ts";

export function WorkflowValidationPanel({
  diagnostics,
}: Readonly<{ diagnostics: readonly WorkflowDiagnostic[] }>) {
  if (diagnostics.length === 0) return <output aria-label="Workflow valid">Workflow valid</output>;
  return (
    <section aria-label="Workflow problems">
      <h2>Problems</h2>
      <ul>
        {diagnostics.map((item) => (
          <li key={`${item.path}:${item.code}`}>
            <strong>{item.code}</strong> {item.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
