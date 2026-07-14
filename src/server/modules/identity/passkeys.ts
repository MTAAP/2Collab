import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

export type RegistrationVerification =
  | Readonly<{ verified: false }>
  | Readonly<{
      verified: true;
      credential: Readonly<{
        credentialId: string;
        publicKey: Uint8Array;
        counter: number;
        transports: readonly string[];
        deviceType: "SINGLE_DEVICE" | "MULTI_DEVICE";
        backedUp: boolean;
      }>;
    }>;

export type AuthenticationVerification =
  | Readonly<{ verified: false }>
  | Readonly<{
      verified: true;
      newCounter: number;
      deviceType: "SINGLE_DEVICE" | "MULTI_DEVICE";
      backedUp: boolean;
    }>;

type CredentialDescriptor = Readonly<{ id: string; transports: readonly string[] }>;

export interface WebAuthnPort {
  generateRegistrationOptions(
    input: Readonly<{
      challenge: Uint8Array;
      rpName: string;
      rpId: string;
      userId: Uint8Array;
      userName: string;
      userDisplayName: string;
      excludeCredentials: readonly CredentialDescriptor[];
    }>,
  ): Promise<Readonly<Record<string, unknown>>>;
  verifyRegistration(
    input: Readonly<{
      response: unknown;
      expectedChallenge: (candidate: string) => Promise<boolean>;
      expectedOrigin: string;
      expectedRpId: string;
    }>,
  ): Promise<RegistrationVerification>;
  generateAuthenticationOptions(
    input: Readonly<{
      challenge: Uint8Array;
      rpId: string;
      allowCredentials?: readonly CredentialDescriptor[];
    }>,
  ): Promise<Readonly<Record<string, unknown>>>;
  verifyAuthentication(
    input: Readonly<{
      response: unknown;
      expectedChallenge: (candidate: string) => Promise<boolean>;
      expectedOrigin: string;
      expectedRpId: string;
      credential: Readonly<{
        id: string;
        publicKey: Uint8Array;
        counter: number;
        transports: readonly string[];
      }>;
    }>,
  ): Promise<AuthenticationVerification>;
}

function transport(value: string): AuthenticatorTransportFuture {
  return value.toLowerCase().replaceAll("_", "-") as AuthenticatorTransportFuture;
}

export const simpleWebAuthnPort: WebAuthnPort = {
  async generateRegistrationOptions(input) {
    return generateRegistrationOptions({
      challenge: new Uint8Array(input.challenge) as Uint8Array<ArrayBuffer>,
      rpName: input.rpName,
      rpID: input.rpId,
      userID: new Uint8Array(input.userId) as Uint8Array<ArrayBuffer>,
      userName: input.userName,
      userDisplayName: input.userDisplayName,
      excludeCredentials: input.excludeCredentials.map((credential) => ({
        id: credential.id,
        transports: credential.transports.map(transport),
      })),
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      attestationType: "none",
    }) as unknown as Readonly<Record<string, unknown>>;
  },
  async verifyRegistration(input) {
    const result = await verifyRegistrationResponse({
      response: input.response as RegistrationResponseJSON,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      requireUserVerification: true,
    });
    if (!result.verified) return { verified: false };
    const { credential } = result.registrationInfo;
    return {
      verified: true,
      credential: {
        credentialId: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
        transports:
          credential.transports?.map((value) => value.toUpperCase().replaceAll("-", "_")) ?? [],
        deviceType:
          result.registrationInfo.credentialDeviceType === "singleDevice"
            ? "SINGLE_DEVICE"
            : "MULTI_DEVICE",
        backedUp: result.registrationInfo.credentialBackedUp,
      },
    };
  },
  async generateAuthenticationOptions(input) {
    return generateAuthenticationOptions({
      challenge: new Uint8Array(input.challenge) as Uint8Array<ArrayBuffer>,
      rpID: input.rpId,
      ...(input.allowCredentials
        ? {
            allowCredentials: input.allowCredentials.map((credential) => ({
              id: credential.id,
              transports: credential.transports.map(transport),
            })),
          }
        : {}),
      userVerification: "required",
    }) as unknown as Readonly<Record<string, unknown>>;
  },
  async verifyAuthentication(input) {
    const result = await verifyAuthenticationResponse({
      response: input.response as AuthenticationResponseJSON,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRPID: input.expectedRpId,
      requireUserVerification: true,
      credential: {
        id: input.credential.id,
        publicKey: new Uint8Array(input.credential.publicKey) as Uint8Array<ArrayBuffer>,
        counter: input.credential.counter,
        transports: input.credential.transports.map(transport),
      },
    });
    if (!result.verified) return { verified: false };
    return {
      verified: true,
      newCounter: result.authenticationInfo.newCounter,
      deviceType:
        result.authenticationInfo.credentialDeviceType === "singleDevice"
          ? "SINGLE_DEVICE"
          : "MULTI_DEVICE",
      backedUp: result.authenticationInfo.credentialBackedUp,
    };
  },
};
