import type { Database } from "bun:sqlite";
import type { ApprovedGateManifest, GateManifest } from "../../../shared/contracts/gates.ts";
import { CommitShaSchema, IdentifierSchema, Sha256Schema } from "../../../shared/contracts/ids.ts";
import type { Result } from "../../../shared/contracts/result.ts";

export function fingerprintGateManifest(manifest: GateManifest): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function approveGateFingerprint(
  database: Database,
  input: ApprovedGateManifest,
): Result<ApprovedGateManifest> {
  if (
    !IdentifierSchema.safeParse(input.projectId).success ||
    !CommitShaSchema.safeParse(input.baseRevision).success ||
    !Sha256Schema.safeParse(input.fingerprint).success ||
    !IdentifierSchema.safeParse(input.approvedByRunnerOwnerId).success ||
    !Number.isInteger(input.approvedAt) ||
    input.approvedAt < 0
  )
    return {
      ok: false,
      error: {
        code: "GATE_APPROVAL_INVALID",
        message: "Gate manifest approval is invalid.",
        retry: "NEVER",
      },
    };
  database
    .query(
      `INSERT INTO approved_gate_manifests(project_id, base_revision, fingerprint, approved_by_runner_owner_id, approved_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(project_id, base_revision, fingerprint) DO NOTHING`,
    )
    .run(
      input.projectId,
      input.baseRevision,
      input.fingerprint,
      input.approvedByRunnerOwnerId,
      input.approvedAt,
    );
  const row = database
    .query<
      { approved_by_runner_owner_id: string; approved_at: number; revoked_at: number | null },
      [string, string, string]
    >(
      `SELECT approved_by_runner_owner_id, approved_at, revoked_at FROM approved_gate_manifests WHERE project_id=? AND base_revision=? AND fingerprint=?`,
    )
    .get(input.projectId, input.baseRevision, input.fingerprint);
  if (
    !row ||
    row.revoked_at !== null ||
    row.approved_by_runner_owner_id !== input.approvedByRunnerOwnerId
  )
    return {
      ok: false,
      error: {
        code: "GATE_FINGERPRINT_STALE",
        message: "Gate manifest fingerprint is not approved.",
        retry: "EXPLICIT_RESUME",
      },
    };
  return { ok: true, value: { ...input, approvedAt: row.approved_at } };
}

export function isGateFingerprintApproved(
  database: Database,
  input: Readonly<{ projectId: string; baseRevision: string; fingerprint: string }>,
): boolean {
  return Boolean(
    database
      .query<{ value: number }, [string, string, string]>(
        `SELECT 1 AS value FROM approved_gate_manifests WHERE project_id=? AND base_revision=? AND fingerprint=? AND revoked_at IS NULL`,
      )
      .get(input.projectId, input.baseRevision, input.fingerprint),
  );
}
