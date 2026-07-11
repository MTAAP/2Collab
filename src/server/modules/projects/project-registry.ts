import type { Database } from "bun:sqlite";
import { z } from "zod";
import { inImmediateTransaction } from "../../db/transaction.ts";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { ProjectId, TeamId } from "../../../shared/contracts/ids.ts";
import {
  CreateProjectSchema,
  InspectProjectSchema,
  ListProjectsSchema,
  type Project,
  ProjectSchema,
} from "../../../shared/contracts/projects.ts";
import type { DomainError, Result } from "../../../shared/contracts/result.ts";
import type { ProjectRegistry } from "./contract.ts";

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: "project" | "audit") => string;
  digest?: (value: string) => Promise<Uint8Array>;
}>;

type ProjectRow = Readonly<{
  id: string;
  team_id: string;
  name: string;
  base_branch: string;
  revision: number;
  created_at: number;
}>;

function error<T>(code: string, message: string, retry: DomainError["retry"] = "NEVER"): Result<T> {
  return { ok: false, error: { code, message, retry } };
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Bun.CryptoHasher("sha256").update(value).digest();
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

const StoredProjectResultSchema = z.object({ ok: z.literal(true), value: ProjectSchema }).strict();

function project(row: ProjectRow): Project {
  return {
    id: row.id as ProjectId,
    teamId: row.team_id as TeamId,
    name: row.name,
    baseBranch: row.base_branch,
    revision: row.revision,
    createdAt: row.created_at as Project["createdAt"],
  };
}

export function createProjectRegistry(dependencies: Dependencies): ProjectRegistry {
  const digest = dependencies.digest ?? sha256;
  const activeMember = (
    actor: Pick<MemberActor, "sessionProof"> & Readonly<{ memberId: string; sessionId: string }>,
    proofHash: Uint8Array,
  ): { role: "OWNER" | "MEMBER" } | null => {
    return dependencies.database
      .query<{ role: "OWNER" | "MEMBER" }, [string, string, Uint8Array, number, number]>(
        `SELECT members.role FROM members
         JOIN sessions ON sessions.member_id = members.id
         WHERE members.id = ? AND sessions.id = ? AND sessions.proof_hash = ?
           AND members.status = 'ACTIVE' AND sessions.kind = 'BROWSER'
           AND sessions.revoked_at IS NULL AND sessions.idle_expires_at > ?
           AND sessions.absolute_expires_at > ?
           AND sessions.member_authority_epoch = members.authority_epoch`,
      )
      .get(actor.memberId, actor.sessionId, proofHash, dependencies.clock(), dependencies.clock());
  };

  const memberAuthority = async (
    actor: Pick<MemberActor, "sessionProof"> & Readonly<{ memberId: string; sessionId: string }>,
  ): Promise<Readonly<{ role: "OWNER" | "MEMBER"; proofHash: Uint8Array }> | null> => {
    if (actor.sessionProof.length < 32 || actor.sessionProof.length > 512) return null;
    const proofHash = await digest(actor.sessionProof);
    const member = activeMember(actor, proofHash);
    return member ? { role: member.role, proofHash } : null;
  };

  const replay = (
    actorId: string,
    storageKey: string,
    inputHash: string,
  ): Result<Project> | undefined => {
    const row = dependencies.database
      .query<{ input_hash: string; result_json: string }, [string, string]>(
        "SELECT input_hash, result_json FROM idempotency_results WHERE actor_id = ? AND idempotency_key = ?",
      )
      .get(actorId, storageKey);
    if (!row) return undefined;
    if (row.input_hash !== inputHash) {
      return error(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used with different input.",
      );
    }
    if (Buffer.byteLength(row.result_json, "utf8") > 16 * 1024) {
      return error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
    }
    try {
      const parsed = StoredProjectResultSchema.safeParse(JSON.parse(row.result_json));
      return parsed.success
        ? (parsed.data as Result<Project>)
        : error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
    } catch {
      return error("IDEMPOTENCY_STORAGE_INVALID", "Stored idempotency result is invalid.");
    }
  };

  return {
    async create(command) {
      const input = CreateProjectSchema.safeParse(command);
      if (!input.success) return error("PROJECT_INPUT_INVALID", "Project input is invalid.");
      const authority = await memberAuthority(input.data.actor);
      if (authority?.role !== "OWNER")
        return error("OWNER_REQUIRED", "Owner authorization is required.");
      try {
        const storageKey = `PROJECT_CREATE:${input.data.idempotencyKey}`;
        const hash = await digest(
          JSON.stringify({ baseBranch: input.data.baseBranch, name: input.data.name }),
        );
        if (hash.byteLength !== 32) {
          return error("PROJECT_STORAGE_FAILED", "Project creation failed.", "SAME_INPUT");
        }
        const inputHash = hex(hash);
        const prior = replay(input.data.actor.memberId, storageKey, inputHash);
        if (prior) return prior;
        return inImmediateTransaction(dependencies.database, () => {
          const currentOwner = dependencies.database
            .query<{ team_id: string }, [string, string, Uint8Array, number, number]>(
              `SELECT deployments.team_id FROM deployments
               JOIN members ON members.id = ?
               JOIN sessions ON sessions.member_id = members.id AND sessions.id = ?
               WHERE deployments.singleton = 1 AND members.role = 'OWNER' AND members.status = 'ACTIVE'
                 AND sessions.proof_hash = ? AND sessions.kind = 'BROWSER'
                 AND sessions.revoked_at IS NULL AND sessions.idle_expires_at > ?
                 AND sessions.absolute_expires_at > ?
                 AND sessions.member_authority_epoch = members.authority_epoch`,
            )
            .get(
              input.data.actor.memberId,
              input.data.actor.sessionId,
              authority.proofHash,
              dependencies.clock(),
              dependencies.clock(),
            );
          if (!currentOwner) return error("OWNER_REQUIRED", "Owner authorization is required.");
          const committedReplay = replay(input.data.actor.memberId, storageKey, inputHash);
          if (committedReplay) return committedReplay;
          const row: ProjectRow = {
            id: dependencies.id("project"),
            team_id: currentOwner.team_id,
            name: input.data.name,
            base_branch: input.data.baseBranch,
            revision: 1,
            created_at: dependencies.clock(),
          };
          dependencies.database
            .query<void, [string, string, string, string, number, number]>(
              "INSERT INTO projects(id, team_id, name, base_branch, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(row.id, row.team_id, row.name, row.base_branch, row.revision, row.created_at);
          const result = { ok: true as const, value: project(row) };
          dependencies.database
            .query<void, [string, string, string, string, string, string, number]>(
              "INSERT INTO audit_events(id, kind, actor_kind, actor_id, subject_id, safe_details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              dependencies.id("audit"),
              "PROJECT_CREATED",
              "MEMBER",
              input.data.actor.memberId,
              row.id,
              JSON.stringify({ teamId: row.team_id, baseBranch: row.base_branch }),
              dependencies.clock(),
            );
          dependencies.database
            .query<void, [string, string, string, string, number]>(
              "INSERT INTO idempotency_results(actor_id, idempotency_key, input_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              input.data.actor.memberId,
              storageKey,
              inputHash,
              JSON.stringify(result),
              dependencies.clock(),
            );
          return result;
        });
      } catch {
        return error("PROJECT_STORAGE_FAILED", "Project creation failed.", "SAME_INPUT");
      }
    },

    async inspect(query) {
      const input = InspectProjectSchema.safeParse(query);
      if (!input.success) return error("PROJECT_INPUT_INVALID", "Project input is invalid.");
      if (!(await memberAuthority(input.data.actor)))
        return error("MEMBER_REQUIRED", "Member authorization is required.");
      const row = dependencies.database
        .query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?")
        .get(input.data.projectId);
      return row
        ? { ok: true, value: project(row) }
        : error("PROJECT_NOT_FOUND", "Project was not found.");
    },

    async list(query) {
      const input = ListProjectsSchema.safeParse(query);
      if (!input.success) return error("PROJECT_INPUT_INVALID", "Project input is invalid.");
      if (!(await memberAuthority(input.data.actor)))
        return error("MEMBER_REQUIRED", "Member authorization is required.");
      return {
        ok: true,
        value: dependencies.database
          .query<ProjectRow, []>("SELECT * FROM projects ORDER BY name, id")
          .all()
          .map(project),
      };
    },
  };
}
