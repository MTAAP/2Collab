import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type {
  PublicCancelRunRequest,
  PublicCreateRunRequest,
  PublicInspectEvidenceRequest,
  PublicInspectRunRequest,
  PublicResumeRunRequest,
  PublicRunResult,
} from "../../../shared/contracts/public-api.ts";
import type { Result } from "../../../shared/contracts/result.ts";

type ResultOf<K extends PublicRunResult["kind"]> = Result<Extract<PublicRunResult, { kind: K }>>;

export interface PublicRunOperations {
  create(actor: MemberActor, request: PublicCreateRunRequest): Promise<ResultOf<"CREATE_RUN">>;
  inspect(actor: MemberActor, request: PublicInspectRunRequest): Promise<ResultOf<"INSPECT_RUN">>;
  cancel(actor: MemberActor, request: PublicCancelRunRequest): Promise<ResultOf<"CANCEL_RUN">>;
  resume(actor: MemberActor, request: PublicResumeRunRequest): Promise<ResultOf<"RESUME_RUN">>;
  evidence(
    actor: MemberActor,
    request: PublicInspectEvidenceRequest,
  ): Promise<ResultOf<"INSPECT_EVIDENCE">>;
}
