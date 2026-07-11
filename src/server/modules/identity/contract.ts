import type { MemberActor } from "../../../shared/contracts/actors.ts";
import type {
  AcceptInvitationWithVerifiedIdentity,
  AuthenticatePasskey,
  BeginMemberRoleChange,
  BeginPasskeyAuthentication,
  BeginPasskeyRegistration,
  BootstrapDeployment,
  ChangeMemberRole,
  CreateInvitation,
  ExchangeInvitationSecret,
  FinishPasskeyRegistration,
  GenerateRecoveryCodes,
  InspectInvitation,
  InvitationIssue,
  InvitationSession,
  ListPasskeys,
  MemberRoleChange,
  MemberSessionIssue,
  PasskeyChallenge,
  PasskeyCredential,
  PasskeyRevocation,
  RecoveryCodeSet,
  RecoverySessionIssue,
  RedeemRecoveryCode,
  RevokeInvitation,
  RevokePasskey,
  TeamInvitation,
} from "../../../shared/contracts/identity.ts";
import type { MemberId } from "../../../shared/contracts/ids.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type { VerifiedProviderIdentity } from "./oidc.ts";
import type { ProviderLink } from "./provider-links.ts";
import type { MemberRemoval } from "./revocation.ts";

export interface IdentityAuthority {
  bootstrap(command: BootstrapDeployment): Promise<Result<MemberSessionIssue>>;
  beginPasskeyRegistration(command: BeginPasskeyRegistration): Promise<Result<PasskeyChallenge>>;
  finishPasskeyRegistration(command: FinishPasskeyRegistration): Promise<Result<PasskeyCredential>>;
  beginPasskeyAuthentication(
    command: BeginPasskeyAuthentication,
  ): Promise<Result<PasskeyChallenge>>;
  authenticate(command: AuthenticatePasskey): Promise<Result<MemberSessionIssue>>;
  beginMemberRoleChange(command: BeginMemberRoleChange): Promise<Result<PasskeyChallenge>>;
  changeMemberRole(command: ChangeMemberRole): Promise<Result<MemberRoleChange>>;
  revokePasskey(command: RevokePasskey): Promise<Result<PasskeyRevocation>>;
  listPasskeys(query: ListPasskeys): Promise<Result<readonly PasskeyCredential[]>>;
  generateRecoveryCodes(command: GenerateRecoveryCodes): Promise<Result<RecoveryCodeSet>>;
  redeemRecoveryCode(command: RedeemRecoveryCode): Promise<Result<RecoverySessionIssue>>;
  invite(command: CreateInvitation): Promise<Result<InvitationIssue>>;
  exchangeInvitation(command: ExchangeInvitationSecret): Promise<Result<InvitationSession>>;
  inspectInvitation(query: InspectInvitation): Promise<Result<TeamInvitation>>;
  revokeInvitation(command: RevokeInvitation): Promise<Result<TeamInvitation>>;
  accept(command: AcceptInvitationWithVerifiedIdentity): Promise<Result<MemberSessionIssue>>;
  linkProvider(
    command: Readonly<{
      idempotencyKey: string;
      actor: MemberActor;
      identity: VerifiedProviderIdentity;
    }>,
  ): Promise<Result<ProviderLink>>;
  acceptProviderInvitation(
    command: Readonly<{
      idempotencyKey: string;
      invitationSessionSecret: string;
      displayName: string;
      identity: VerifiedProviderIdentity;
    }>,
  ): Promise<
    Result<
      Readonly<{
        link: ProviderLink;
        session: Readonly<{
          actor: MemberActor;
          csrfProof: string;
          idleExpiresAt: number;
          absoluteExpiresAt: number;
        }>;
      }>
    >
  >;
  remove(
    command: Readonly<{
      idempotencyKey: string;
      actor: MemberActor;
      memberId: MemberId;
      expectedRevision: number;
    }>,
  ): Promise<Result<MemberRemoval>>;
}
