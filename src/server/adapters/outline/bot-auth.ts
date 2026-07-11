import type { Result } from "../../../shared/contracts/result.ts";
import type { OutlineIdentity } from "../../modules/connectors/outline-credentials.ts";

export type ResolvedOutlineAuthorization = Readonly<{
  memberIdentity?: Extract<OutlineIdentity, { kind: "MEMBER" }>;
  botIdentity?: Extract<OutlineIdentity, { kind: "BOT" }>;
}>;

export function resolveOutlineIdentity(
  input: Readonly<{
    operation: "HUMAN_WRITE" | "AGENT_OPERATION" | "READ";
    authorization: ResolvedOutlineAuthorization;
  }>,
): Result<OutlineIdentity> {
  if (input.operation === "HUMAN_WRITE") {
    return input.authorization.memberIdentity
      ? { ok: true, value: input.authorization.memberIdentity }
      : {
          ok: false,
          error: {
            code: "OUTLINE_MEMBER_GRANT_REQUIRED",
            message: "A delegated member grant is required.",
            retry: "EXPLICIT_RESUME",
          },
        };
  }
  return input.authorization.botIdentity
    ? { ok: true, value: input.authorization.botIdentity }
    : {
        ok: false,
        error: {
          code: "RUN_AUTHORITY_REQUIRED",
          message: "Bot run authority is required.",
          retry: "NEVER",
        },
      };
}
