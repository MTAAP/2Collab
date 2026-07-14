import type { GateManifest, ProjectGate } from "../../shared/contracts/gates.ts";
import type { Result } from "../../shared/contracts/result.ts";
import { fingerprintGateManifest } from "../../server/modules/gates/fingerprints.ts";

type Approval = Readonly<{
  projectId: string;
  baseRevision: string;
  fingerprint: string;
  manifest: GateManifest;
}>;
export interface ApprovedManifestLoader {
  approve(approval: Approval): void;
  claimEvaluation(evaluationId: string, bindingDigest: string): boolean;
  resolve(
    input: Readonly<{
      projectId: string;
      baseRevision: string;
      fingerprint: string;
      gateKey: string;
    }>,
  ): Result<ProjectGate>;
}
export function createApprovedManifestLoader(): ApprovedManifestLoader {
  const approvals = new Map<string, Approval>();
  const evaluations = new Map<string, string>();
  const key = (value: Pick<Approval, "projectId" | "baseRevision" | "fingerprint">) =>
    `${value.projectId}\0${value.baseRevision}\0${value.fingerprint}`;
  return {
    approve(approval) {
      if (fingerprintGateManifest(approval.manifest) !== approval.fingerprint)
        throw new Error("GATE_FINGERPRINT_INVALID");
      approvals.set(key(approval), structuredClone(approval));
    },
    claimEvaluation(evaluationId, bindingDigest) {
      if (evaluations.has(evaluationId)) return false;
      evaluations.set(evaluationId, bindingDigest);
      return true;
    },
    resolve(input) {
      const approval = approvals.get(key(input));
      if (!approval || fingerprintGateManifest(approval.manifest) !== input.fingerprint)
        return {
          ok: false,
          error: {
            code: "GATE_FINGERPRINT_STALE",
            message: "Gate manifest fingerprint is not approved.",
            retry: "EXPLICIT_RESUME",
          },
        };
      const gate = approval.manifest.gates.find((candidate) => candidate.key === input.gateKey);
      if (!gate)
        return {
          ok: false,
          error: {
            code: "GATE_NOT_FOUND",
            message: "Project gate is unavailable.",
            retry: "NEVER",
          },
        };
      return { ok: true, value: gate };
    },
  };
}
