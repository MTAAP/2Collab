import type {
  AuthorityPreview,
  AuthorityPreviewRequest,
  CollabCommand,
  CommandResultFor,
  CoordinationQuery,
  QueryResultFor,
} from "./commands.ts";
import type { Result } from "./result.ts";

export interface ExecutionAuthority {
  preview(request: AuthorityPreviewRequest): Promise<AuthorityPreview>;
  execute<C extends CollabCommand>(command: C): Promise<Result<CommandResultFor<C>>>;
  query<Q extends CoordinationQuery>(query: Q): Promise<Result<QueryResultFor<Q>>>;
}

export type {
  AuthorityFact,
  AuthorityPreview,
  AuthorityPreviewRequest,
  CollabCommand,
  CommandBase,
  CommandResult,
  CommandResultFor,
  CoordinationQuery,
  QueryResult,
  QueryResultFor,
  SensitiveOperation,
} from "./commands.ts";

export { CollabCommandSchema, CoordinationQuerySchema } from "./commands.ts";
