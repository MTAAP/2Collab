import type { PersonalWorkflowPreset } from "../../../shared/contracts/templates.ts";

export function WorkflowBindings({ preset }: Readonly<{ preset: PersonalWorkflowPreset }>) {
  return (
    <section aria-labelledby="workflow-bindings-title">
      <h2 id="workflow-bindings-title">Bind my execution</h2>
      <ul>
        {Object.entries(preset.bindings).map(([stepKey, binding]) => (
          <li key={stepKey}>
            <strong>{stepKey}</strong>
            <span>
              {binding.personalRunPresetId} version {binding.expectedVersion}
            </span>
            <button type="button" aria-label={`Replace binding for ${stepKey}`}>
              Replace explicitly
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
