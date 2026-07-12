import type { Database } from "bun:sqlite";
import type { GitHubMutation } from "../../../shared/contracts/github.ts";
import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type { ExactRevisionMutation } from "../connectors/contract.ts";
import { changedPathCollision } from "../coordination-records/collisions.ts";
import { evaluateMutationGuard } from "../coordination-records/mutation-guard.ts";
import { requireDeliverableDiffEvidence } from "../evidence/diff-evidence.ts";
import { evaluateCheck } from "../evidence/github-checks.ts";
import { githubInboxEvent } from "../inbox/github-events.ts";
import { upsertInboxEvent } from "../inbox/inbox.ts";
import { assignAndDelegate } from "./assignment-delegation.ts";
import type { GitHubPort } from "./contract.ts";
import { dependencyWarning } from "./dependencies.ts";
import { closingReference, observeDelivery } from "./delivery.ts";
import { performGitHubMutation, type GitHubConnectorAuthority } from "./mutations.ts";

export function createGitHubCoordinationService(
  dependencies: Readonly<{
    database: Database;
    clock: () => number;
    github: GitHubPort;
    connectorAuthority: GitHubConnectorAuthority;
  }>,
) {
  const mutate = (actor: MemberActor, command: ExactRevisionMutation<GitHubMutation>) =>
    performGitHubMutation({
      github: dependencies.github,
      connectorAuthority: dependencies.connectorAuthority,
      authorized: { authorityKind: "MEMBER", actor, command },
    });
  return {
    mutate,
    assignAndDelegate,
    evaluateMutationGuard,
    requireDeliverableDiffEvidence,
    changedPathCollision,
    evaluateCheck,
    dependencyWarning,
    closingReference,
    observeDelivery,
    publishInbox(input: Parameters<typeof githubInboxEvent>[0]) {
      return upsertInboxEvent(dependencies.database, {
        ...githubInboxEvent(input),
        now: dependencies.clock(),
      });
    },
    async inspectDelivery(
      input: Readonly<{
        scope: Parameters<GitHubPort["inspect"]>[0];
        pullRequest: Parameters<GitHubPort["inspect"]>[1];
        issue: Parameters<GitHubPort["inspect"]>[1];
      }>,
    ) {
      const [pullRequest, issue] = await Promise.all([
        dependencies.github.inspect(input.scope, input.pullRequest),
        dependencies.github.inspect(input.scope, input.issue),
      ]);
      return pullRequest.ok && issue.ok
        ? {
            ok: true as const,
            value: observeDelivery({ pullRequest: pullRequest.value, issue: issue.value }),
          }
        : pullRequest.ok
          ? issue
          : pullRequest;
    },
  } satisfies Readonly<Record<string, unknown>> & {
    mutate(actor: MemberActor, command: ExactRevisionMutation<GitHubMutation>): Promise<unknown>;
  };
}
