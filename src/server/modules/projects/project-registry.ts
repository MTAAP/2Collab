import type { Database } from "bun:sqlite";
import { inImmediateTransaction } from "../../db/transaction.ts";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { ProjectId, TeamId } from "../../../shared/contracts/ids.ts";
import {
  CreateProjectSchema,
  InspectProjectSchema,
  ListProjectsSchema,
  type Project,
} from "../../../shared/contracts/projects.ts";
import type { DomainError, Result } from "../../../shared/contracts/result.ts";
import type { ProjectRegistry } from "./contract.ts";

type Dependencies = Readonly<{
  database: Database;
  clock: () => number;
  id: (prefix: "project") => string;
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

  return {
    async create(command) {
      const input = CreateProjectSchema.safeParse(command);
      if (!input.success) return error("PROJECT_INPUT_INVALID", "Project input is invalid.");
      const authority = await memberAuthority(input.data.actor);
      if (authority?.role !== "OWNER")
        return error("OWNER_REQUIRED", "Owner authorization is required.");
      try {
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
          return { ok: true as const, value: project(row) };
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
