import type {
  CanonicalOutlineOrigin,
  EncryptedOutlineOAuthGrant,
  EphemeralProviderAccess,
  OutlineProviderIdentity,
  ProviderRevocationResult,
  ProviderTokenSet,
  VerifiedOutlineOAuthMetadata,
  VerifiedOutlineOAuthTransaction,
} from "../../../shared/contracts/outline.ts";
import type { Result } from "../../../shared/contracts/result.ts";

export interface OutlineOAuthProviderPort {
  discover(origin: CanonicalOutlineOrigin): Promise<Result<VerifiedOutlineOAuthMetadata>>;
  exchange(
    transaction: VerifiedOutlineOAuthTransaction,
    authorizationCode: string,
  ): Promise<Result<ProviderTokenSet>>;
  refresh(grant: EncryptedOutlineOAuthGrant): Promise<Result<ProviderTokenSet>>;
  revoke(grant: EncryptedOutlineOAuthGrant): Promise<Result<ProviderRevocationResult>>;
  inspectIdentity(access: EphemeralProviderAccess): Promise<Result<OutlineProviderIdentity>>;
}
