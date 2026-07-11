import type { Database } from "bun:sqlite";
import type {
  AdditionalDocumentRequest,
  DocumentWriteGrant,
} from "../../../shared/contracts/document-grants.ts";
import type {
  DocumentConflict,
  DocumentProposal,
} from "../../../shared/contracts/document-proposals.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";

const missing = (code: string): Result<never> => ({
  ok: false,
  error: { code, message: "Outline collaboration state is unavailable.", retry: "REFRESH" },
});

export function createOutlineDocumentRepository(database: Database, clock: () => number) {
  const loadGrant = (grantId: string): Result<DocumentWriteGrant> => {
    const row = database
      .query<
        {
          grant_id: string;
          project_id: string;
          connector_id: string;
          run_id: string;
          grantor_member_id: string;
          connector_epoch: number;
          grant_revision: number;
          created_at: number;
          expires_at: number;
          revoked_at: number | null;
        },
        [string]
      >("SELECT * FROM document_write_grants WHERE grant_id = ?")
      .get(grantId);
    if (!row) return missing("DOCUMENT_GRANT_NOT_FOUND");
    const documents = database
      .query<
        {
          document_id: string;
          source_revision: string;
          comparable_digest: string;
          document_revision: number;
        },
        [string]
      >(
        "SELECT document_id,source_revision,comparable_digest,document_revision FROM document_write_grant_documents WHERE grant_id=? ORDER BY document_id",
      )
      .all(grantId);
    const operations = database
      .query<{ operation: "EDIT_CONTENT" }, [string]>(
        "SELECT operation FROM document_write_grant_operations WHERE grant_id=? ORDER BY operation",
      )
      .all(grantId)
      .map((item) => item.operation);
    return {
      ok: true,
      value: {
        grantId: row.grant_id as never,
        projectId: row.project_id as never,
        connectorId: row.connector_id as never,
        runId: row.run_id as never,
        grantorMemberId: row.grantor_member_id as never,
        connectorEpoch: row.connector_epoch,
        grantRevision: row.grant_revision,
        documents: documents.map((item) => ({
          documentId: item.document_id as never,
          sourceRevision: item.source_revision,
          comparableDigest: item.comparable_digest as never,
          documentRevision: item.document_revision,
        })),
        operations,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
      },
    };
  };
  return {
    loadGrant,
    saveGrant(grant: DocumentWriteGrant): Result<DocumentWriteGrant> {
      try {
        return inImmediateTransaction(database, () => {
          database
            .query(
              `INSERT INTO document_write_grants(grant_id,project_id,connector_id,run_id,grantor_member_id,
              connector_epoch,grant_revision,created_at,expires_at,revoked_at)
             VALUES(?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              grant.grantId,
              grant.projectId,
              grant.connectorId,
              grant.runId,
              grant.grantorMemberId,
              grant.connectorEpoch,
              grant.grantRevision,
              grant.createdAt,
              grant.expiresAt,
              grant.revokedAt ?? null,
            );
          for (const document of grant.documents)
            database
              .query(
                "INSERT INTO document_write_grant_documents(grant_id,document_id,source_revision,comparable_digest,document_revision) VALUES(?,?,?,?,?)",
              )
              .run(
                grant.grantId,
                document.documentId,
                document.sourceRevision,
                document.comparableDigest,
                document.documentRevision,
              );
          for (const operation of grant.operations)
            database
              .query("INSERT INTO document_write_grant_operations(grant_id,operation) VALUES(?,?)")
              .run(grant.grantId, operation);
          return { ok: true, value: grant };
        });
      } catch {
        return missing("DOCUMENT_GRANT_PERSIST_FAILED");
      }
    },
    saveRequest(request: AdditionalDocumentRequest): Result<AdditionalDocumentRequest> {
      try {
        database
          .query(
            `INSERT INTO additional_document_requests(request_id,grant_id,document_id,requested_by_run_id,status,
            request_revision,created_at,decided_by_member_id,decided_at) VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            request.requestId,
            request.grantId,
            request.documentId,
            request.requestedByRunId,
            request.status,
            request.requestRevision,
            request.createdAt,
            request.decidedByMemberId ?? null,
            request.decidedAt ?? null,
          );
        return { ok: true, value: request };
      } catch {
        return missing("DOCUMENT_REQUEST_PERSIST_FAILED");
      }
    },
    decideRequest(
      request: AdditionalDocumentRequest,
      expectedRevision: number,
    ): Result<AdditionalDocumentRequest> {
      if (
        request.status === "PENDING" ||
        !request.decidedByMemberId ||
        request.decidedAt === undefined
      )
        return missing("DOCUMENT_REQUEST_DECISION_INVALID");
      const changed = database
        .query(
          `UPDATE additional_document_requests SET status=?,request_revision=?,decided_by_member_id=?,decided_at=?
         WHERE request_id=? AND status='PENDING' AND request_revision=? AND revoked_at IS NULL`,
        )
        .run(
          request.status,
          request.requestRevision,
          request.decidedByMemberId,
          request.decidedAt,
          request.requestId,
          expectedRevision,
        );
      return changed.changes === 1
        ? { ok: true, value: request }
        : missing("DOCUMENT_REQUEST_STALE");
    },
    advanceGrant(
      grantId: string,
      expectedRevision: number,
      documentId: string,
      sourceRevision: string,
      comparableDigest: string,
    ): Result<Readonly<{ grantRevision: number }>> {
      try {
        return inImmediateTransaction(database, () => {
          const updated = database
            .query(
              "UPDATE document_write_grants SET grant_revision=grant_revision+1 WHERE grant_id=? AND grant_revision=? AND revoked_at IS NULL AND expires_at>?",
            )
            .run(grantId, expectedRevision, clock());
          if (updated.changes !== 1) return missing("DOCUMENT_GRANT_REVISION_STALE");
          const document = database
            .query(
              "UPDATE document_write_grant_documents SET source_revision=?,comparable_digest=?,document_revision=document_revision+1 WHERE grant_id=? AND document_id=?",
            )
            .run(sourceRevision, comparableDigest, grantId, documentId);
          if (document.changes !== 1) throw new Error("DOCUMENT_GRANT_SCOPE_DENIED");
          return { ok: true, value: { grantRevision: expectedRevision + 1 } };
        });
      } catch {
        return missing("DOCUMENT_GRANT_UPDATE_FAILED");
      }
    },
    persistConflict(conflict: DocumentConflict): Result<DocumentConflict> {
      try {
        database
          .query(
            "INSERT OR IGNORE INTO document_conflicts(conflict_id,proposal_id,current_revision,current_digest,detected_at) VALUES(?,?,?,?,?)",
          )
          .run(
            conflict.conflictId,
            conflict.proposalId,
            conflict.currentRevision,
            conflict.currentDigest,
            conflict.detectedAt,
          );
        return { ok: true, value: conflict };
      } catch {
        return missing("OUTLINE_CONFLICT_PERSIST_FAILED");
      }
    },
    saveProposal(proposal: DocumentProposal): Result<DocumentProposal> {
      try {
        database
          .query(
            `INSERT INTO document_proposals(proposal_id,project_id,connector_id,connector_epoch,document_id,
            run_id,attempt_id,base_revision,base_digest,authored_patch,authored_patch_digest,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            proposal.proposalId,
            proposal.projectId,
            proposal.connectorId,
            proposal.connectorEpoch,
            proposal.documentId,
            proposal.runId,
            proposal.attemptId,
            proposal.baseRevision,
            proposal.baseDigest,
            proposal.authoredPatch.value,
            proposal.authoredPatch.digest,
            proposal.createdAt,
          );
        return { ok: true, value: proposal };
      } catch {
        return missing("OUTLINE_PROPOSAL_PERSIST_FAILED");
      }
    },
    loadProposal(proposalId: string): Result<DocumentProposal> {
      const row = database
        .query<Record<string, string | number>, [string]>(
          "SELECT * FROM document_proposals WHERE proposal_id=? AND revoked_at IS NULL",
        )
        .get(proposalId);
      if (!row) return missing("OUTLINE_PROPOSAL_NOT_FOUND");
      return {
        ok: true,
        value: {
          proposalId: row.proposal_id as never,
          projectId: row.project_id as never,
          connectorId: row.connector_id as never,
          connectorEpoch: row.connector_epoch as number,
          documentId: row.document_id as never,
          runId: row.run_id as never,
          attemptId: row.attempt_id as never,
          baseRevision: row.base_revision as string,
          baseDigest: row.base_digest as never,
          authoredPatch: {
            format: "UNIFIED_TEXT_PATCH_V1",
            value: row.authored_patch as string,
            digest: row.authored_patch_digest as never,
          },
          createdAt: row.created_at as number,
        },
      };
    },
    recordWorkingDisposition(
      input: Readonly<{
        id: string;
        workingDocumentId: string;
        expectedLifecycleRevision: number;
        disposition: "KEEP" | "PROMOTE" | "ARCHIVE";
        actorMemberId: string;
        resultingRevision?: string;
      }>,
    ): Result<Readonly<{ lifecycleRevision: number }>> {
      try {
        return inImmediateTransaction(database, () => {
          const current = database
            .query<{ connector_id: string; connector_epoch: number }, [string, string, number]>(
              `SELECT working.connector_id,working.connector_epoch FROM external_working_documents working
             JOIN connector_epochs epoch ON epoch.connector_id=working.connector_id
               AND epoch.epoch=working.connector_epoch AND epoch.review_state='READY'
             JOIN members member ON member.id=? AND member.status='ACTIVE'
             WHERE working.working_document_id=? AND working.lifecycle_revision=? AND working.revoked_at IS NULL`,
            )
            .get(input.actorMemberId, input.workingDocumentId, input.expectedLifecycleRevision);
          if (!current) return missing("WORKING_DOCUMENT_STALE");
          database
            .query(
              `INSERT INTO working_document_dispositions(id,working_document_id,expected_lifecycle_revision,
              disposition,actor_member_id,resulting_revision,created_at) VALUES(?,?,?,?,?,?,?)`,
            )
            .run(
              input.id,
              input.workingDocumentId,
              input.expectedLifecycleRevision,
              input.disposition,
              input.actorMemberId,
              input.resultingRevision ?? null,
              clock(),
            );
          database
            .query(
              "UPDATE external_working_documents SET lifecycle_revision=lifecycle_revision+1 WHERE working_document_id=? AND lifecycle_revision=? AND revoked_at IS NULL",
            )
            .run(input.workingDocumentId, input.expectedLifecycleRevision);
          return { ok: true, value: { lifecycleRevision: input.expectedLifecycleRevision + 1 } };
        });
      } catch {
        return missing("WORKING_DOCUMENT_DISPOSITION_FAILED");
      }
    },
  };
}
