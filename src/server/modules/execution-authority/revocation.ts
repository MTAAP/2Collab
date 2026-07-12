import type { Database } from "bun:sqlite";
import type { ApplyRevocation } from "../../../shared/contracts/commands.ts";

export function revocationSource(command: ApplyRevocation): Readonly<{
  kind: ApplyRevocation["source"]["kind"];
  id: string;
  epoch: number;
}> {
  const source = command.source;
  switch (source.kind) {
    case "MEMBER":
      return { kind: source.kind, id: source.memberId, epoch: source.authorityEpoch };
    case "CONNECTOR":
      return { kind: source.kind, id: source.connectorId, epoch: source.connectorEpoch };
    case "RUNNER":
      return { kind: source.kind, id: source.runnerId, epoch: source.runnerEpoch };
    case "EXPOSURE":
      return { kind: source.kind, id: source.exposureId, epoch: source.revision };
    case "REPOSITORY":
      return { kind: source.kind, id: source.repositoryId, epoch: source.revision };
    case "RUN":
      return { kind: source.kind, id: source.runId, epoch: source.revision };
  }
}

export function latestRevocationEpoch(database: Database, kind: string, id: string): number {
  return (
    database
      .query<{ epoch: number | null }, [string, string]>(
        "SELECT max(source_epoch) AS epoch FROM authority_revocations WHERE source_kind = ? AND source_id = ?",
      )
      .get(kind, id)?.epoch ?? 0
  );
}
