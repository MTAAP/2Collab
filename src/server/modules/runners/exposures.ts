import { createHash } from "node:crypto";
import type { ExposureSubject } from "../../../shared/contracts/runners.ts";

export function exposureAcknowledgementText(subject: ExposureSubject): string {
  return [
    `Runner ${subject.runnerId} is owned by ${subject.ownerMemberId}.`,
    `Project ${subject.projectId} mapping revision ${subject.mappingRevision} uses profile ${subject.profileId} version ${subject.profileVersion}.`,
    "Dispatched agent processes execute as the runner operating-system user and may use that user's locally configured credentials.",
    "Isolation is a dedicated worktree, not a host sandbox.",
    `Policy revision ${subject.policyRevision}; security policy ${subject.securityPolicyVersion}; digest ${subject.securityDigest}.`,
  ].join(" ");
}

export function exposureAcknowledgementDigest(subject: ExposureSubject, text: string): string {
  return createHash("sha256").update(JSON.stringify({ subject, text }), "utf8").digest("hex");
}
