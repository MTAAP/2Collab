import { useState } from "react";
import type { PlanArtifact } from "../../../shared/contracts/plan-artifacts.ts";

export function PlanArtifactView({ artifact }: Readonly<{ artifact: PlanArtifact }>) {
  return (
    <article aria-labelledby="plan-artifact-title">
      <h2 id="plan-artifact-title">Plan Artifact</h2>
      <p>{artifact.approach}</p>
      <h3>Assumptions</h3>
      <ul>
        {artifact.assumptions.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h3>Risks</h3>
      <ul>
        {artifact.risks.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h3>Verification strategy</h3>
      <ul>
        {artifact.verificationStrategy.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </article>
  );
}

const PORTABLE_PLAN: PlanArtifact = {
  approach: "Implement the accepted workflow through shared authority and exact revision checks.",
  assumptions: ["The published Git reference remains available."],
  risks: ["Authority may be revoked before implementation."],
  affectedAreas: ["Workflow engine", "Acceptance evidence"],
  verificationStrategy: ["Run focused tests, package checks, and an authorized live journey."],
  evidence: [
    { kind: "REFERENCE", reference: "published-git-reference", revision: "fixture-revision" },
  ],
};

export function PlanningWorkflowJourney() {
  const [approved, setApproved] = useState(false);
  return (
    <section>
      <h1>Portable Planning Workflow</h1>
      <p>Claude · runner-a · Orca</p>
      <PlanArtifactView artifact={PORTABLE_PLAN} />
      <button type="button" disabled={approved} onClick={() => setApproved(true)}>
        Approve plan
      </button>
      {approved ? <p>Codex · runner-b · Native</p> : null}
    </section>
  );
}
