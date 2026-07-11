import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../src/server/db/connection.ts";
import { migrate } from "../../../src/server/db/migrate.ts";
import type { IdentityAuthority } from "../../../src/server/modules/identity/contract.ts";
import {
  createIdentityAuthority,
  type IdentityAuthorityDependencies,
} from "../../../src/server/modules/identity/identity-authority.ts";
import { hashOneTimeSecret, sha256 } from "../../../src/server/modules/identity/recovery.ts";
import type { MemberSessionIssue } from "../../../src/shared/contracts/identity.ts";
import type { Result } from "../../../src/shared/contracts/result.ts";
import { StrictFakeWebAuthn } from "../../fixtures/identity.ts";

const directories: string[] = [];

class AsyncBarrier {
  private arrivals = 0;
  private release!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async wait(): Promise<void> {
    this.arrivals += 1;
    if (this.arrivals === 2) this.release();
    await this.released;
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function authorityPair(
  options: {
    digestA?: IdentityAuthorityDependencies["digest"];
    digestB?: IdentityAuthorityDependencies["digest"];
    deriveA?: IdentityAuthorityDependencies["deriveSecret"];
    deriveB?: IdentityAuthorityDependencies["deriveSecret"];
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "2collab-identity-race-"));
  directories.push(directory);
  const path = join(directory, "collab.sqlite");
  const firstDatabase = openDatabase(path);
  migrate(firstDatabase);
  const secondDatabase = openDatabase(path);
  migrate(secondDatabase);
  const firstWebAuthn = new StrictFakeWebAuthn();
  const secondWebAuthn = new StrictFakeWebAuthn();
  const bootstrapSecret = "file-backed-bootstrap-secret-32-bytes";
  let firstSequence = 0;
  let secondSequence = 0;
  const make = (
    prefix: string,
    database: typeof firstDatabase,
    webAuthn: StrictFakeWebAuthn,
    next: () => number,
    digest?: IdentityAuthorityDependencies["digest"],
    deriveSecret?: IdentityAuthorityDependencies["deriveSecret"],
  ) =>
    createIdentityAuthority({
      database,
      webAuthn,
      bootstrapSecret,
      publicOrigin: "http://localhost:3000",
      rpId: "localhost",
      rpName: "2Collab Race",
      executionAuthority: {
        async execute() {
          return { ok: true, value: { applied: true as const } };
        },
      },
      clock: () => 1_000_000,
      id: (kind) => `${kind}_${prefix}_${next()}`,
      randomBytes: (length) => {
        const bytes = new Uint8Array(length);
        bytes.fill((next() % 250) + 1);
        return bytes;
      },
      ...(digest ? { digest } : {}),
      ...(deriveSecret ? { deriveSecret } : {}),
    });
  const first = make(
    "a",
    firstDatabase,
    firstWebAuthn,
    () => ++firstSequence,
    options.digestA,
    options.deriveA,
  );
  const second = make(
    "b",
    secondDatabase,
    secondWebAuthn,
    () => ++secondSequence,
    options.digestB,
    options.deriveB,
  );
  return {
    first,
    second,
    firstDatabase,
    secondDatabase,
    firstWebAuthn,
    secondWebAuthn,
    bootstrapSecret,
    close() {
      firstDatabase.close();
      secondDatabase.close();
    },
  };
}

async function bootstrap(
  identity: IdentityAuthority,
  bootstrapSecret: string,
): Promise<Result<MemberSessionIssue>> {
  const begun = await identity.beginPasskeyRegistration({
    idempotencyKey: "file-bootstrap-begin",
    principal: { kind: "BOOTSTRAP", secret: bootstrapSecret },
    displayName: "Ada",
  });
  if (!begun.ok) throw new Error(begun.error.code);
  return identity.bootstrap({
    idempotencyKey: "file-bootstrap-finish",
    bootstrapSecret,
    displayName: "Ada",
    credentialName: "Ada passkey",
    challengeId: begun.value.challengeId,
    response: { challenge: begun.value.challenge, credentialId: "credential-ada" },
  });
}

describe("file-backed identity concurrency", () => {
  test("two connections have exactly one bootstrap winner", async () => {
    const pair = await authorityPair();
    try {
      const begun = await pair.first.beginPasskeyRegistration({
        idempotencyKey: "bootstrap-race-begin",
        principal: { kind: "BOOTSTRAP", secret: pair.bootstrapSecret },
        displayName: "Ada",
      });
      if (!begun.ok) throw new Error(begun.error.code);
      const base = {
        bootstrapSecret: pair.bootstrapSecret,
        displayName: "Ada",
        credentialName: "Passkey",
        challengeId: begun.value.challengeId,
        response: { challenge: begun.value.challenge, credentialId: "credential-race" },
      } as const;
      const verificationBarrier = new AsyncBarrier();
      pair.firstWebAuthn.beforeRegistrationResult = () => verificationBarrier.wait();
      pair.secondWebAuthn.beforeRegistrationResult = () => verificationBarrier.wait();
      const results = await Promise.all([
        pair.first.bootstrap({ ...base, idempotencyKey: "bootstrap-race-a" }),
        pair.second.bootstrap({ ...base, idempotencyKey: "bootstrap-race-b" }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(
        pair.firstDatabase
          .query<{ deployments: number; owners: number }, []>(
            `SELECT (SELECT count(*) FROM deployments) AS deployments,
                    (SELECT count(*) FROM members WHERE role = 'OWNER') AS owners`,
          )
          .get(),
      ).toEqual({ deployments: 1, owners: 1 });
    } finally {
      pair.close();
    }
  });

  test("exchange and acceptance each have one winner across two connections", async () => {
    let exchangeSecret = "";
    let exchangeArmed = false;
    const exchangeBarrier = new AsyncBarrier();
    const racingDigest = async (value: string) => {
      const result = await sha256(value);
      if (exchangeArmed && value === exchangeSecret) await exchangeBarrier.wait();
      return result;
    };
    const pair = await authorityPair({ digestA: racingDigest, digestB: racingDigest });
    try {
      const owner = await bootstrap(pair.first, pair.bootstrapSecret);
      if (!owner.ok) throw new Error(owner.error.code);
      const actor = {
        kind: "MEMBER",
        memberId: owner.value.memberId,
        sessionId: owner.value.id,
        sessionProof: owner.value.proof,
      } as const;
      const invitation = await pair.first.invite({
        actor,
        idempotencyKey: "file-invite",
        label: "Grace",
      });
      if (!invitation.ok) throw new Error(invitation.error.code);
      exchangeSecret = invitation.value.secret;
      exchangeArmed = true;
      const exchanges = await Promise.all([
        pair.first.exchangeInvitation({
          secret: invitation.value.secret,
          idempotencyKey: "exchange-a",
        }),
        pair.second.exchangeInvitation({
          secret: invitation.value.secret,
          idempotencyKey: "exchange-b",
        }),
      ]);
      expect(exchanges.filter((result) => result.ok)).toHaveLength(1);
      const exchange = exchanges.find((result) => result.ok);
      if (!exchange?.ok) throw new Error("missing exchange winner");
      const begun = await pair.first.beginPasskeyRegistration({
        idempotencyKey: "file-accept-begin",
        principal: { kind: "INVITATION", secret: exchange.value.secret },
        displayName: "Grace",
      });
      if (!begun.ok) throw new Error(begun.error.code);
      const base = {
        invitationSessionSecret: exchange.value.secret,
        displayName: "Grace",
        credentialName: "Grace passkey",
        challengeId: begun.value.challengeId,
        response: { challenge: begun.value.challenge, credentialId: "credential-grace" },
      } as const;
      const acceptanceBarrier = new AsyncBarrier();
      pair.firstWebAuthn.beforeRegistrationResult = () => acceptanceBarrier.wait();
      pair.secondWebAuthn.beforeRegistrationResult = () => acceptanceBarrier.wait();
      const accepts = await Promise.all([
        pair.first.accept({ ...base, idempotencyKey: "accept-a" }),
        pair.second.accept({ ...base, idempotencyKey: "accept-b" }),
      ]);
      expect(accepts.filter((result) => result.ok)).toHaveLength(1);
      expect(
        pair.firstDatabase
          .query<{ count: number }, []>("SELECT count(*) AS count FROM members")
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      pair.close();
    }
  });

  test("recovery redemption has one winner across two connections", async () => {
    let redemptionArmed = false;
    const redemptionBarrier = new AsyncBarrier();
    const racingDerive = async (secret: string, salt: Uint8Array) => {
      const result = await hashOneTimeSecret(secret, salt);
      if (redemptionArmed) await redemptionBarrier.wait();
      return result;
    };
    const pair = await authorityPair({ deriveA: racingDerive, deriveB: racingDerive });
    try {
      const owner = await bootstrap(pair.first, pair.bootstrapSecret);
      if (!owner.ok) throw new Error(owner.error.code);
      const actor = {
        kind: "MEMBER",
        memberId: owner.value.memberId,
        sessionId: owner.value.id,
        sessionProof: owner.value.proof,
      } as const;
      const codes = await pair.first.generateRecoveryCodes({
        actor,
        idempotencyKey: "file-recovery-generate",
      });
      if (!codes.ok) throw new Error(codes.error.code);
      const code = codes.value.codes[0] ?? "";
      redemptionArmed = true;
      const results = await Promise.all([
        pair.first.redeemRecoveryCode({
          idempotencyKey: "file-redeem-a",
          memberId: owner.value.memberId,
          code,
        }),
        pair.second.redeemRecoveryCode({
          idempotencyKey: "file-redeem-b",
          memberId: owner.value.memberId,
          code,
        }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
    } finally {
      pair.close();
    }
  });

  test("authentication refuses session issuance when another connection revokes the member", async () => {
    const pair = await authorityPair();
    try {
      const owner = await bootstrap(pair.first, pair.bootstrapSecret);
      if (!owner.ok) throw new Error(owner.error.code);
      const begun = await pair.first.beginPasskeyAuthentication({
        idempotencyKey: "file-auth-begin",
        credentialId: "credential-ada",
      });
      if (!begun.ok) throw new Error(begun.error.code);
      pair.firstWebAuthn.beforeAuthenticationResult = () => {
        pair.secondDatabase
          .query<void, [string]>(
            "UPDATE members SET status = 'REVOKED', revision = revision + 1 WHERE id = ?",
          )
          .run(owner.value.memberId);
      };
      const result = await pair.first.authenticate({
        idempotencyKey: "file-auth-finish",
        challengeId: begun.value.challengeId,
        response: {
          challenge: begun.value.challenge,
          credentialId: "credential-ada",
          newCounter: 1,
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("MEMBER_REVOKED");
      expect(
        pair.firstDatabase
          .query<{ count: number }, []>("SELECT count(*) AS count FROM sessions")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      pair.close();
    }
  });

  test("owner authority is revalidated after async secret hashing", async () => {
    let mutate: (() => void) | undefined;
    let armed = false;
    let proofOrSecretDigests = 0;
    const digest = async (value: string) => {
      const result = await sha256(value);
      if (armed && value.length === 43 && ++proofOrSecretDigests === 2) {
        armed = false;
        mutate?.();
      }
      return result;
    };
    const pair = await authorityPair({ digestA: digest });
    try {
      const owner = await bootstrap(pair.first, pair.bootstrapSecret);
      if (!owner.ok) throw new Error(owner.error.code);
      mutate = () => {
        pair.secondDatabase
          .query<void, [string]>(
            "UPDATE members SET role = 'MEMBER', revision = revision + 1 WHERE id = ?",
          )
          .run(owner.value.memberId);
      };
      armed = true;
      const result = await pair.first.invite({
        actor: {
          kind: "MEMBER",
          memberId: owner.value.memberId,
          sessionId: owner.value.id,
          sessionProof: owner.value.proof,
        },
        idempotencyKey: "stale-owner-invite",
        label: "Grace",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("AUTHORITY_STALE");
      expect(
        pair.firstDatabase
          .query<{ count: number }, []>("SELECT count(*) AS count FROM invitations")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      pair.close();
    }
  });
});
