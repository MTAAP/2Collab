import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { GitHubMutation, GitHubProjection } from "../../../shared/contracts/github.ts";
import { githubReferenceKey } from "../../../shared/contracts/github.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { ExactRevisionMutation, Observed, SourceConnector } from "../connectors/contract.ts";
import type { GitHubPort } from "./contract.ts";

type MemberCommand = Readonly<{
  authorityKind: "MEMBER";
  actor: MemberActor;
  command: ExactRevisionMutation<GitHubMutation>;
}>;
type AttemptCommand = Readonly<{
  authorityKind: "ATTEMPT";
  authorizationId: string;
  authorizationProof: string;
  command: ExactRevisionMutation<GitHubMutation>;
}>;
export type AuthorizedGitHubMutation = MemberCommand | AttemptCommand;

export type GitHubConnectorAuthority = Readonly<{
  mutateAsMember<R, P, M>(
    connector: SourceConnector<R, P, M>,
    input: Readonly<{
      actor: MemberActor;
      reference: string;
      operation: string;
      command: ExactRevisionMutation<M>;
    }>,
  ): Promise<Result<Observed<P>>>;
  mutateAsAttempt<R, P, M>(
    connector: SourceConnector<R, P, M>,
    input: Readonly<{
      authorizationId: string;
      authorizationProof: string;
      reference: string;
      operation: string;
      command: ExactRevisionMutation<M>;
    }>,
  ): Promise<Result<Observed<P>>>;
}>;

function reference(mutation: GitHubMutation): string {
  switch (mutation.kind) {
    case "CREATE_ISSUE":
      return `REPOSITORY:${mutation.repository.repositoryId}`;
    case "EDIT_ISSUE":
    case "ADD_COMMENT":
    case "SET_LABELS":
    case "SET_ASSIGNEES":
    case "SET_ISSUE_STATE":
      return githubReferenceKey(mutation.issue);
    case "SET_MILESTONE":
      return githubReferenceKey(mutation.item);
    case "CREATE_MILESTONE":
      return `REPOSITORY:${mutation.repository.repositoryId}`;
    case "EDIT_MILESTONE":
      return githubReferenceKey(mutation.milestone);
    case "ADD_PROJECT_ITEM":
    case "REMOVE_PROJECT_ITEM":
    case "SET_PROJECT_FIELD":
    case "MOVE_PROJECT_ITEM":
      return githubReferenceKey(mutation.project);
  }
}

export async function performGitHubMutation(
  input: Readonly<{
    github: GitHubPort;
    connectorAuthority: GitHubConnectorAuthority;
    authorized: AuthorizedGitHubMutation;
  }>,
): Promise<Result<Observed<GitHubProjection>>> {
  const operation = input.authorized.command.mutation.kind;
  const target = reference(input.authorized.command.mutation);
  if (input.authorized.authorityKind === "MEMBER") {
    return input.connectorAuthority.mutateAsMember(input.github, {
      actor: input.authorized.actor,
      reference: target,
      operation,
      command: input.authorized.command,
    });
  }
  return input.connectorAuthority.mutateAsAttempt(input.github, {
    authorizationId: input.authorized.authorizationId,
    authorizationProof: input.authorized.authorizationProof,
    reference: target,
    operation,
    command: input.authorized.command,
  });
}

export function githubMutationReference(mutation: GitHubMutation): string {
  return reference(mutation);
}
