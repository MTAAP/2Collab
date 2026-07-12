import { useState } from "react";
import type { WorkflowDefinition } from "../../../shared/contracts/workflow.ts";
import { exportWorkflowYaml, importWorkflowYaml } from "../../../server/modules/workflows/yaml.ts";

export function WorkflowYamlIo({
  definition,
  replace,
}: Readonly<{ definition: WorkflowDefinition; replace(value: WorkflowDefinition): void }>) {
  const [source, setSource] = useState(() => exportWorkflowYaml(definition));
  const [error, setError] = useState<string>();
  return (
    <section aria-label="Workflow YAML">
      <label htmlFor="workflow-yaml">YAML</label>
      <textarea
        id="workflow-yaml"
        value={source}
        onChange={(event) => setSource(event.target.value)}
      />
      <button
        type="button"
        onClick={() => {
          try {
            replace(importWorkflowYaml(source));
            setError(undefined);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "WORKFLOW_YAML_INVALID");
          }
        }}
      >
        Import draft
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
