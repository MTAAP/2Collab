import type { MemberActor } from "../../../src/shared/contracts/actors.ts";
import type { GitHubMutation, GitHubProjection } from "../../../src/shared/contracts/github.ts";
import type {
  ExactRevisionMutation,
  Observed,
  SourceConnector,
} from "../../../src/server/modules/connectors/contract.ts";
import type { GitHubConnectorAuthority } from "../../../src/server/modules/github-coordination/mutations.ts";
import { StrictGitHubAdapter } from "../../fixtures/github/strict-github-adapter.ts";

export const actor: MemberActor = {
  kind: "MEMBER",
  memberId: "member_1" as never,
  sessionId: "session_1" as never,
  sessionProof: "s".repeat(32),
};
export const scope = {
  projectId: "project_1" as never,
  connectorId: "github_1" as never,
  connectorEpoch: 1,
  references: ["REPOSITORY:101", "ISSUE:101:1", "PROJECT:PVT_1"],
  operations: [
    "CREATE_ISSUE",
    "EDIT_ISSUE",
    "ADD_COMMENT",
    "SET_LABELS",
    "SET_ASSIGNEES",
    "SET_MILESTONE",
    "SET_ISSUE_STATE",
    "CREATE_MILESTONE",
    "EDIT_MILESTONE",
    "ADD_PROJECT_ITEM",
    "REMOVE_PROJECT_ITEM",
    "SET_PROJECT_FIELD",
    "MOVE_PROJECT_ITEM",
  ],
};

export function command(
  mutation: GitHubMutation,
  precondition: ExactRevisionMutation<GitHubMutation>["precondition"] = { kind: "ABSENT" },
): ExactRevisionMutation<GitHubMutation> {
  return {
    projectId: scope.projectId,
    connectorId: scope.connectorId,
    connectorEpoch: 1,
    idempotencyKey: `idempotency_${mutation.kind}_${crypto.randomUUID()}`,
    precondition,
    actionDigest: new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(mutation))
      .digest("hex") as never,
    mutation,
  };
}

export function fixture() {
  const github = StrictGitHubAdapter.seed({
    connectorId: "github_1",
    connectorEpoch: 1,
    selectedRepositoryIds: ["101"],
    providerRepositoryIds: ["101", "202"],
    selectedProjectIds: ["PVT_1"],
  });
  github.addIssue({ repositoryId: "101", number: 1, title: "Original" });
  const authority: GitHubConnectorAuthority = {
    async mutateAsMember<R, P, M>(
      connector: SourceConnector<R, P, M>,
      input: {
        actor: MemberActor;
        reference: string;
        operation: string;
        command: ExactRevisionMutation<M>;
      },
    ) {
      const result = await connector.mutate(
        {
          kind: "CONNECTOR_OPERATION",
          id: input.command.idempotencyKey,
          proof: "p".repeat(32),
          projectId: input.command.projectId,
          connectorId: input.command.connectorId,
          connectorEpoch: input.command.connectorEpoch,
          reference: input.reference,
          operation: input.operation,
          actionDigest: input.command.actionDigest,
          expiresAt: Date.now() + 60_000,
        },
        input.command,
      );
      if (result.ok) github.events.push(`PROJECTED:${input.operation}`);
      return result;
    },
    async mutateAsAttempt<R, P, M>(
      connector: SourceConnector<R, P, M>,
      input: {
        authorizationId: string;
        authorizationProof: string;
        reference: string;
        operation: string;
        command: ExactRevisionMutation<M>;
      },
    ) {
      return this.mutateAsMember(connector, { actor, ...input });
    },
  };
  return { github, authority };
}

export async function observedIssue(
  github: StrictGitHubAdapter,
): Promise<Observed<GitHubProjection>> {
  const result = await github.inspect(scope, { kind: "ISSUE", repositoryId: "101", number: 1 });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
