import type { VerifiedRunnerPrincipal } from "../../../shared/contracts/actors.ts";
import type { Result } from "../../../shared/contracts/result.ts";
import type {
  AcknowledgeTeamExposure,
  AdvertiseSafeProfileVersion,
  AuthenticateRunnerAccess,
  BeginRunnerPairing,
  CommittedRunnerPolicyReplacement,
  ConfirmedRunnerPairing,
  ConfirmRunnerPairing,
  ConsumeRunnerPairing,
  CreateTeamExposure,
  ExchangeRunnerCredential,
  ExposureAcknowledgement,
  ExposureAcknowledgementPreview,
  InspectRunnerEligibility,
  PreviewExposureAcknowledgement,
  RegisterRunnerMapping,
  ReplaceRunnerMapping,
  RevokeExposureAcknowledgement,
  RevokeRunner,
  RevokeRunnerMapping,
  RevokeTeamExposure,
  RunnerAccessIssue,
  RunnerCredentialEnvelope,
  RunnerEligibilityFacts,
  RunnerHeartbeat,
  RunnerLeaseView,
  RunnerMapping,
  RunnerPairingChallenge,
  RunnerPolicyFacts,
  RunnerRevocation,
  SafeProfileVersion,
  TeamDispatchExposure,
} from "../../../shared/contracts/runners.ts";

export interface RunnerKeyProofPort {
  verifyNewKey(
    input: Readonly<{ keyId: string; proof: string }>,
  ): Promise<Result<Readonly<{ keyThumbprint: string }>>>;
  verifyPossession(
    input: Readonly<{ keyThumbprint: string; proof: string }>,
  ): Promise<Result<Readonly<{ verified: true }>>>;
}

export interface RunnerRequestProofPort {
  verify(
    input: Readonly<{
      keyThumbprint: string;
      proof: string;
      method: "GET";
      uri: string;
      nonce: string;
      accessTokenHash: string;
      now: number;
    }>,
  ): Promise<Result<Readonly<{ jti: string; issuedAt: number }>>>;
}

export interface RunnerRegistry {
  beginPairing(command: BeginRunnerPairing): Promise<Result<RunnerPairingChallenge>>;
  confirmPairing(command: ConfirmRunnerPairing): Promise<Result<ConfirmedRunnerPairing>>;
  consumePairing(command: ConsumeRunnerPairing): Promise<Result<RunnerCredentialEnvelope>>;
  registerMapping(command: RegisterRunnerMapping): Promise<Result<RunnerMapping>>;
  replaceMapping(command: ReplaceRunnerMapping): Promise<Result<RunnerMapping>>;
  revokeMapping(command: RevokeRunnerMapping): Promise<Result<RunnerMapping>>;
  advertiseProfile(command: AdvertiseSafeProfileVersion): Promise<Result<SafeProfileVersion>>;
  previewExposureAcknowledgement(
    query: PreviewExposureAcknowledgement,
  ): Promise<Result<ExposureAcknowledgementPreview>>;
  acknowledgeExposure(command: AcknowledgeTeamExposure): Promise<Result<ExposureAcknowledgement>>;
  revokeAcknowledgement(
    command: RevokeExposureAcknowledgement,
  ): Promise<Result<ExposureAcknowledgement>>;
  createExposure(command: CreateTeamExposure): Promise<Result<TeamDispatchExposure>>;
  revokeExposure(command: RevokeTeamExposure): Promise<Result<TeamDispatchExposure>>;
  heartbeat(command: RunnerHeartbeat): Promise<Result<RunnerLeaseView>>;
  revoke(command: RevokeRunner): Promise<Result<RunnerRevocation>>;
  inspectEligibility(query: InspectRunnerEligibility): Promise<Result<RunnerEligibilityFacts>>;
  inspectLease(runnerId: string): RunnerLeaseView;
}

export interface RunnerAuthenticationAuthority {
  exchangeCredential(command: ExchangeRunnerCredential): Promise<Result<RunnerAccessIssue>>;
  authenticateAccess(command: AuthenticateRunnerAccess): Promise<Result<VerifiedRunnerPrincipal>>;
  authenticateUpgrade(command: AuthenticateRunnerAccess): Promise<Result<VerifiedRunnerPrincipal>>;
}

export interface RunnerPolicyFactsStore {
  replaceForAuthority(command: CommittedRunnerPolicyReplacement): RunnerPolicyFacts;
}
