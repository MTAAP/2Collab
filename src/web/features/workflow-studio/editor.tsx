import { Background, Controls, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import type { CanvasLayout, WorkflowDefinition } from "../../../shared/contracts/workflow.ts";
import { toReactFlow } from "./definition-adapter.ts";
import { useWorkflowHistory } from "./history.tsx";
import { StructuredWorkflowOutline } from "./structured-outline.tsx";
import { WorkflowValidationPanel } from "./validation-panel.tsx";
import { WorkflowYamlIo } from "./yaml-io.tsx";

export function WorkflowEditor({
  initialDefinition,
  layout,
}: Readonly<{ initialDefinition: WorkflowDefinition; layout: CanvasLayout }>) {
  const history = useWorkflowHistory(initialDefinition);
  const [selectedKey, setSelectedKey] = useState(initialDefinition.nodes[0]?.key);
  const flow = useMemo(() => toReactFlow(history.value, layout), [history.value, layout]);
  const selected = history.value.nodes.find((node) => node.key === selectedKey);
  return (
    <section>
      <header>
        <h1>Workflow Studio</h1>
        <button type="button" disabled={!history.canUndo} onClick={history.undo}>
          Undo
        </button>
        <button type="button" disabled={!history.canRedo} onClick={history.redo}>
          Redo
        </button>
        <button type="button">Validate</button>
        <button type="button">Publish version</button>
      </header>
      <div style={{ display: "grid", gridTemplateColumns: "16rem 1fr 18rem", minHeight: "36rem" }}>
        <StructuredWorkflowOutline definition={history.value} select={setSelectedKey} />
        <section data-react-flow-derived="true" aria-label="Workflow canvas">
          <ReactFlowProvider>
            <ReactFlow nodes={[...flow.nodes]} edges={[...flow.edges]} fitView>
              <Background />
              <Controls />
            </ReactFlow>
          </ReactFlowProvider>
        </section>
        <section aria-label="Node inspector">
          <h2>Inspector</h2>
          {selected ? (
            <>
              <strong>{selected.key}</strong>
              <p>{selected.kind}</p>
            </>
          ) : (
            <p>Select a node.</p>
          )}
        </section>
      </div>
      <WorkflowValidationPanel diagnostics={[]} />
      <WorkflowYamlIo definition={history.value} replace={history.replace} />
    </section>
  );
}

const initialDefinition: WorkflowDefinition = {
  inputs: [{ key: "goal", type: "STRING", required: true }],
  nodes: [
    { kind: "START", key: "start" },
    {
      kind: "AGENT_RUN",
      key: "implement",
      runTemplateVersionId: "run_template_implement_v1",
      resultKeys: ["READY_FOR_REVIEW"],
    },
    { kind: "TERMINAL", key: "done", outcome: "COMPLETED" },
  ],
  transitions: [
    { from: "start", resultKey: "STARTED", to: "implement" },
    { from: "implement", resultKey: "READY_FOR_REVIEW", to: "done" },
  ],
  maximumRunCount: 1,
  cycleBounds: {},
  maximumParallelBranches: 1,
  maximumConcurrency: 1,
  absoluteDeadlineMs: 900_000,
};
const initialLayout: CanvasLayout = {
  nodes: [
    { key: "start", x: 0, y: 120, collapsed: false },
    { key: "implement", x: 240, y: 120, collapsed: false },
    { key: "done", x: 480, y: 120, collapsed: false },
  ],
  viewport: { x: 0, y: 0, zoom: 1 },
  collapsedGroups: [],
};

export function WorkflowStudioFeature() {
  return <WorkflowEditor initialDefinition={initialDefinition} layout={initialLayout} />;
}
