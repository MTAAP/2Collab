import type { Result } from "../../../shared/contracts/result.ts";
import type { ExactRevisionMutation, Observed } from "../../modules/connectors/contract.ts";

export type RevisionCasResult<T> = Readonly<{
  observed: Observed<T>;
  consistency: "ATOMIC" | "RESIDUAL_RACE";
}>;

export async function performRevisionCas<T, M>(
  input: Readonly<{
    current: Observed<T>;
    command: ExactRevisionMutation<M>;
    write: () => Promise<Result<Observed<T>>>;
    nativeConditionalWrite?: boolean;
  }>,
): Promise<Result<RevisionCasResult<T>>> {
  const precondition = input.command.precondition;
  if (
    precondition.kind !== "ABSENT" &&
    (precondition.sourceRevision !== input.current.sourceRevision ||
      precondition.comparableDigest !== input.current.comparableDigest)
  ) {
    return {
      ok: false,
      error: {
        code: "SOURCE_REVISION_STALE",
        message: "Source revision is stale.",
        retry: "REFRESH",
        details: { observedRevision: input.current.sourceRevision },
      },
    };
  }
  const written = await input.write();
  return written.ok
    ? {
        ok: true,
        value: {
          observed: written.value,
          consistency: input.nativeConditionalWrite ? "ATOMIC" : "RESIDUAL_RACE",
        },
      }
    : written;
}
