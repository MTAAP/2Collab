import { openDatabase } from "../../src/server/db/connection.ts";
import { migrate } from "../../src/server/db/migrate.ts";
import {
  createIdentityAuthority,
  type IdentityAuthorityDependencies,
} from "../../src/server/modules/identity/identity-authority.ts";
import type {
  AuthenticationVerification,
  RegistrationVerification,
  WebAuthnPort,
} from "../../src/server/modules/identity/passkeys.ts";
import type {
  AcceptInvitationWithVerifiedIdentity,
  AuthenticatePasskey,
  BootstrapDeployment,
  CreateInvitation,
} from "../../src/shared/contracts/identity.ts";

type RegistrationResponse = Readonly<{
  challenge: string;
  credentialId: string;
  publicKey?: readonly number[];
  counter?: number;
  deviceType?: "SINGLE_DEVICE" | "MULTI_DEVICE";
  backedUp?: boolean;
  transports?: readonly string[];
  origin?: string;
  rpId?: string;
  userVerified?: boolean;
}>;

type AuthenticationResponse = Readonly<{
  challenge: string;
  credentialId: string;
  newCounter?: number;
  backedUp?: boolean;
  origin?: string;
  rpId?: string;
  userVerified?: boolean;
  deviceType?: "SINGLE_DEVICE" | "MULTI_DEVICE";
}>;

export class StrictFakeWebAuthn implements WebAuthnPort {
  readonly registrationInputs: unknown[] = [];
  readonly authenticationInputs: unknown[] = [];
  failRegistration = false;
  failAuthentication = false;
  beforeRegistrationResult?: () => void | Promise<void>;
  beforeAuthenticationResult?: () => void | Promise<void>;

  async generateRegistrationOptions(input: {
    challenge: Uint8Array;
    rpName: string;
    rpId: string;
    userId: Uint8Array;
    userName: string;
    userDisplayName: string;
    excludeCredentials: readonly Readonly<{ id: string; transports: readonly string[] }>[];
  }): Promise<Readonly<Record<string, unknown>>> {
    this.registrationInputs.push(input);
    return {
      challenge: Buffer.from(input.challenge).toString("base64url"),
      rp: { id: input.rpId, name: input.rpName },
      user: { id: "opaque", name: input.userName, displayName: input.userDisplayName },
      authenticatorSelection: { userVerification: "required" },
    };
  }

  async verifyRegistration(input: {
    response: unknown;
    expectedChallenge: (candidate: string) => Promise<boolean>;
    expectedOrigin: string;
    expectedRpId: string;
  }): Promise<RegistrationVerification> {
    this.registrationInputs.push(input);
    const response = input.response as RegistrationResponse;
    if (
      this.failRegistration ||
      response.userVerified === false ||
      (response.origin !== undefined && response.origin !== input.expectedOrigin) ||
      (response.rpId !== undefined && response.rpId !== input.expectedRpId) ||
      !(await input.expectedChallenge(response.challenge))
    ) {
      return { verified: false };
    }
    await this.beforeRegistrationResult?.();
    return {
      verified: true,
      credential: {
        credentialId: response.credentialId,
        publicKey: new Uint8Array(response.publicKey ?? [1, 2, 3]),
        counter: response.counter ?? 0,
        transports: response.transports ?? ["INTERNAL"],
        deviceType: response.deviceType ?? "MULTI_DEVICE",
        backedUp: response.backedUp ?? true,
      },
    };
  }

  async generateAuthenticationOptions(input: {
    challenge: Uint8Array;
    rpId: string;
    allowCredentials?: readonly Readonly<{ id: string; transports: readonly string[] }>[];
  }): Promise<Readonly<Record<string, unknown>>> {
    this.authenticationInputs.push(input);
    return {
      challenge: Buffer.from(input.challenge).toString("base64url"),
      rpId: input.rpId,
      ...(input.allowCredentials ? { allowCredentials: input.allowCredentials } : {}),
      userVerification: "required",
    };
  }

  async verifyAuthentication(input: {
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
  }): Promise<AuthenticationVerification> {
    this.authenticationInputs.push(input);
    const response = input.response as AuthenticationResponse;
    const nextCounter = response.newCounter ?? input.credential.counter;
    if (
      this.failAuthentication ||
      response.userVerified === false ||
      (response.origin !== undefined && response.origin !== input.expectedOrigin) ||
      (response.rpId !== undefined && response.rpId !== input.expectedRpId) ||
      response.credentialId !== input.credential.id ||
      (input.credential.counter > 0 && nextCounter <= input.credential.counter) ||
      !(await input.expectedChallenge(response.challenge))
    ) {
      return { verified: false };
    }
    await this.beforeAuthenticationResult?.();
    return {
      verified: true,
      newCounter: nextCounter,
      backedUp: response.backedUp ?? true,
      deviceType: response.deviceType ?? "MULTI_DEVICE",
    };
  }
}

export type IdentityFixture = ReturnType<typeof createIdentityFixture>;

export function createIdentityFixture(overrides: Partial<IdentityAuthorityDependencies> = {}) {
  const database = openDatabase(":memory:");
  migrate(database);
  let now = 1_000_000;
  let sequence = 0;
  const webAuthn = new StrictFakeWebAuthn();
  const bootstrapSecret = "bootstrap-secret-with-at-least-32-bytes";
  const dependencies: IdentityAuthorityDependencies = {
    database,
    clock: () => now,
    id: (prefix) => `${prefix}_${++sequence}`,
    randomBytes: (length) => {
      const bytes = new Uint8Array(length);
      bytes.fill((++sequence % 250) + 1);
      return bytes;
    },
    webAuthn,
    bootstrapSecret,
    publicOrigin: "http://localhost:3000",
    rpId: "localhost",
    rpName: "2Collab Test",
    ...overrides,
  };
  const identity = createIdentityAuthority(dependencies);
  const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

  async function bootstrap(displayName = "Ada") {
    const begun = await identity.beginPasskeyRegistration({
      idempotencyKey: `begin-bootstrap-${key(displayName)}`,
      principal: { kind: "BOOTSTRAP", secret: bootstrapSecret },
      displayName,
    });
    if (!begun.ok) throw new Error(begun.error.code);
    return identity.bootstrap({
      idempotencyKey: `bootstrap-${key(displayName)}`,
      bootstrapSecret,
      displayName,
      credentialName: `${displayName} passkey`,
      challengeId: begun.value.challengeId,
      response: {
        challenge: begun.value.challenge,
        credentialId: `credential-${displayName.toLowerCase()}`,
      },
    } as BootstrapDeployment);
  }

  async function invite(
    owner: { id: string; memberId: string; proof: string },
    label = "Teammate",
  ) {
    return identity.invite({
      actor: {
        kind: "MEMBER",
        memberId: owner.memberId,
        sessionId: owner.id,
        sessionProof: owner.proof,
      },
      idempotencyKey: `invite-${key(label)}`,
      label,
    } as CreateInvitation);
  }

  async function accept(invitation: { secret: string }, displayName = "Grace") {
    const exchange = await identity.exchangeInvitation({
      secret: invitation.secret,
      idempotencyKey: `exchange-${key(displayName)}`,
    });
    if (!exchange.ok) return exchange;
    const begun = await identity.beginPasskeyRegistration({
      idempotencyKey: `begin-invitation-${key(displayName)}`,
      principal: { kind: "INVITATION", secret: exchange.value.secret },
      displayName,
    });
    if (!begun.ok) return begun;
    return identity.accept({
      idempotencyKey: `accept-${key(displayName)}`,
      invitationSessionSecret: exchange.value.secret,
      displayName,
      credentialName: `${displayName} passkey`,
      challengeId: begun.value.challengeId,
      response: {
        challenge: begun.value.challenge,
        credentialId: `credential-${displayName.toLowerCase()}`,
      },
    } as AcceptInvitationWithVerifiedIdentity);
  }

  function databaseText(): string {
    return new TextDecoder().decode(database.serialize());
  }

  return {
    identity,
    database,
    webAuthn,
    bootstrapSecret,
    bootstrap,
    invite,
    accept,
    databaseText,
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    close: () => database.close(),
    authenticationCommand: (challengeId: string, challenge: string, credentialId: string) =>
      ({
        idempotencyKey: `authenticate-${++sequence}`,
        challengeId,
        response: { challenge, credentialId, newCounter: 1 },
      }) as AuthenticatePasskey,
    idempotencyKey: (prefix = "test") => `${key(prefix)}-${++sequence}`,
  };
}
