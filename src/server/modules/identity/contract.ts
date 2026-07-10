import type { Result } from "../../../shared/contracts/result.ts";
import type {
  AcceptInvitationWithVerifiedIdentity,
  AuthenticatePasskey,
  BeginPasskeyAuthentication,
  BeginPasskeyRegistration,
  BootstrapDeployment,
  CreateInvitation,
  ExchangeInvitationSecret,
  FinishPasskeyRegistration,
  GenerateRecoveryCodes,
  InspectInvitation,
  InvitationSession,
  ListPasskeys,
  MemberSession,
  PasskeyChallenge,
  PasskeyCredential,
  PasskeyRevocation,
  RecoveryCodeSet,
  RecoverySession,
  RedeemRecoveryCode,
  RevokeInvitation,
  RevokePasskey,
  TeamInvitation,
} from "../../../shared/contracts/identity.ts";

export interface IdentityAuthority {
  bootstrap(command: BootstrapDeployment): Promise<Result<MemberSession>>;
  beginPasskeyRegistration(command: BeginPasskeyRegistration): Promise<Result<PasskeyChallenge>>;
  finishPasskeyRegistration(command: FinishPasskeyRegistration): Promise<Result<PasskeyCredential>>;
  beginPasskeyAuthentication(
    command: BeginPasskeyAuthentication,
  ): Promise<Result<PasskeyChallenge>>;
  authenticate(command: AuthenticatePasskey): Promise<Result<MemberSession>>;
  revokePasskey(command: RevokePasskey): Promise<Result<PasskeyRevocation>>;
  listPasskeys(query: ListPasskeys): Promise<Result<readonly PasskeyCredential[]>>;
  generateRecoveryCodes(command: GenerateRecoveryCodes): Promise<Result<RecoveryCodeSet>>;
  redeemRecoveryCode(command: RedeemRecoveryCode): Promise<Result<RecoverySession>>;
  invite(command: CreateInvitation): Promise<Result<TeamInvitation & { secret: string }>>;
  exchangeInvitation(command: ExchangeInvitationSecret): Promise<Result<InvitationSession>>;
  inspectInvitation(query: InspectInvitation): Promise<Result<TeamInvitation>>;
  revokeInvitation(command: RevokeInvitation): Promise<Result<TeamInvitation>>;
  accept(command: AcceptInvitationWithVerifiedIdentity): Promise<Result<MemberSession>>;
}
