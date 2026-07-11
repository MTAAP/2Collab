import { afterEach, describe, expect, test } from "bun:test";
import { createIdentityFixture, type IdentityFixture } from "../../fixtures/identity.ts";

const fixtures: IdentityFixture[] = [];
const fixture = () => {
  const value = createIdentityFixture();
  fixtures.push(value);
  return value;
};

afterEach(() =>
  fixtures.splice(0).forEach((value) => {
    value.close();
  }),
);

describe("local identity lifecycle", () => {
  test("bootstrap is one-time, transactional, and creates an owner with a verified passkey", async () => {
    const value = fixture();
    const [first, second] = await Promise.all([value.bootstrap("Ada"), value.bootstrap("Grace")]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const rejected = first.ok ? second : first;
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("DEPLOYMENT_ALREADY_BOOTSTRAPPED");
    expect(
      value.database
        .query<{ role: string; count: number }, []>(
          "SELECT role, count(*) AS count FROM members GROUP BY role",
        )
        .get(),
    ).toEqual({ role: "OWNER", count: 1 });
    expect(
      value.database.query<{ count: number }, []>("SELECT count(*) AS count FROM sessions").get(),
    ).toEqual({ count: 1 });
    expect(
      value.database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM passkey_credentials")
        .get(),
    ).toEqual({ count: 1 });
    expect(value.databaseText()).not.toContain(value.bootstrapSecret);
    const ceremonyAfterClaim = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "bootstrap-after-claim",
      principal: { kind: "BOOTSTRAP", secret: value.bootstrapSecret },
      displayName: "Later",
    });
    expect(ceremonyAfterClaim.ok).toBe(false);
    if (!ceremonyAfterClaim.ok)
      expect(ceremonyAfterClaim.error.code).toBe("DEPLOYMENT_ALREADY_BOOTSTRAPPED");
  });

  test("invitation secrets are hash-only, exchange once, and acceptance is single-use", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const invitation = await value.invite(owner.value);
    if (!invitation.ok) throw new Error(invitation.error.code);
    expect(invitation.value).toEqual(
      expect.objectContaining({
        deploymentId: expect.stringMatching(/^deployment_/),
        teamId: expect.stringMatching(/^team_/),
        inviterDisplayName: "Ada",
        role: "MEMBER",
      }),
    );
    expect(value.databaseText()).not.toContain(invitation.value.secret);
    const exchange = await value.identity.exchangeInvitation({
      secret: invitation.value.secret,
      idempotencyKey: "exchange-grace",
    });
    if (!exchange.ok) throw new Error(exchange.error.code);
    expect(value.databaseText()).not.toContain(exchange.value.secret);
    const replayExchange = await value.identity.exchangeInvitation({
      secret: invitation.value.secret,
      idempotencyKey: "exchange-grace-replay",
    });
    expect(replayExchange.ok).toBe(false);
    if (!replayExchange.ok) expect(replayExchange.error.code).toBe("INVITATION_EXCHANGED");

    const begun = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "begin-grace-invitation",
      principal: { kind: "INVITATION", secret: exchange.value.secret },
      displayName: "Grace",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    const command = {
      idempotencyKey: "accept-grace",
      invitationSessionSecret: exchange.value.secret,
      displayName: "Grace",
      credentialName: "Grace laptop",
      challengeId: begun.value.challengeId,
      response: { challenge: begun.value.challenge, credentialId: "credential-grace" },
    } as const;
    const [accepted, replay] = await Promise.all([
      value.identity.accept(command),
      value.identity.accept({ ...command, idempotencyKey: "accept-grace-race" }),
    ]);
    expect([accepted.ok, replay.ok].filter(Boolean)).toHaveLength(1);
    const successfulAcceptance = accepted.ok ? accepted : replay;
    const rejectedAcceptance = accepted.ok ? replay : accepted;
    expect(rejectedAcceptance.ok).toBe(false);
    if (!rejectedAcceptance.ok) expect(rejectedAcceptance.error.code).toBe("INVITATION_USED");
    expect(
      value.database
        .query<{ role: string }, [string]>("SELECT role FROM members WHERE id = ?")
        .get(successfulAcceptance.ok ? successfulAcceptance.value.memberId : ""),
    ).toEqual({ role: "MEMBER" });
    const memberActor = successfulAcceptance.ok
      ? {
          kind: "MEMBER" as const,
          memberId: successfulAcceptance.value.memberId,
          sessionId: successfulAcceptance.value.id,
          sessionProof: successfulAcceptance.value.proof,
        }
      : undefined;
    if (!memberActor) throw new Error("accept failed");
    const deniedInspect = await value.identity.inspectInvitation({
      actor: memberActor,
      invitationId: invitation.value.id,
    });
    expect(deniedInspect.ok).toBe(false);
    if (!deniedInspect.ok) expect(deniedInspect.error.code).toBe("OWNER_REQUIRED");
    const deniedRevoke = await value.identity.revokeInvitation({
      actor: memberActor,
      idempotencyKey: "member-denied-revoke",
      invitationId: invitation.value.id,
    });
    expect(deniedRevoke.ok).toBe(false);
    if (!deniedRevoke.ok) expect(deniedRevoke.error.code).toBe("OWNER_REQUIRED");

    for (const raw of [
      value.bootstrapSecret,
      invitation.value.secret,
      exchange.value.secret,
      begun.value.challenge,
    ]) {
      expect(value.databaseText()).not.toContain(raw);
      expect(JSON.stringify(rejectedAcceptance)).not.toContain(raw);
    }
  });

  test("invitation inspection and revocation are owner-only and honor the exact expiry boundary", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const invitation = await value.invite(owner.value, "Short lived");
    if (!invitation.ok) throw new Error(invitation.error.code);
    const actor = {
      kind: "MEMBER",
      memberId: owner.value.memberId,
      sessionId: owner.value.id,
      sessionProof: owner.value.proof,
    } as const;
    const inspected = await value.identity.inspectInvitation({
      actor,
      invitationId: invitation.value.id,
    });
    expect(inspected.ok).toBe(true);
    const second = await value.invite(owner.value, "Revoked");
    if (!second.ok) throw new Error(second.error.code);
    expect(
      (
        await value.identity.revokeInvitation({
          actor,
          idempotencyKey: "owner-revoke-invitation",
          invitationId: second.value.id,
        })
      ).ok,
    ).toBe(true);
    value.advance(48 * 60 * 60);
    const expired = await value.identity.exchangeInvitation({
      secret: invitation.value.secret,
      idempotencyKey: "exchange-expired",
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe("INVITATION_EXPIRED");

    const revoked = await value.identity.exchangeInvitation({
      secret: second.value.secret,
      idempotencyKey: "exchange-revoked",
    });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error.code).toBe("INVITATION_REVOKED");
  });

  test("authenticates independent credentials and revision-guards stale counter updates", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const actor = {
      kind: "MEMBER",
      memberId: owner.value.memberId,
      sessionId: owner.value.id,
      sessionProof: owner.value.proof,
    } as const;
    const begunRegistration = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "begin-second-passkey",
      principal: actor,
      displayName: "Ada",
    });
    if (!begunRegistration.ok) throw new Error(begunRegistration.error.code);
    const registered = await value.identity.finishPasskeyRegistration({
      idempotencyKey: "finish-second-passkey",
      principal: actor,
      challengeId: begunRegistration.value.challengeId,
      credentialName: "Security key",
      response: {
        challenge: begunRegistration.value.challenge,
        credentialId: "credential-security-key",
        counter: 0,
      },
    });
    expect(registered.ok).toBe(true);

    const auth = await value.identity.beginPasskeyAuthentication({
      idempotencyKey: "begin-auth-ada",
      credentialId: "credential-ada",
    });
    if (!auth.ok) throw new Error(auth.error.code);
    const command = value.authenticationCommand(
      auth.value.challengeId,
      auth.value.challenge,
      "credential-ada",
    );
    const [first, stale] = await Promise.all([
      value.identity.authenticate(command),
      value.identity.authenticate({ ...command, idempotencyKey: "stale-counter-race" }),
    ]);
    expect([first.ok, stale.ok].filter(Boolean)).toHaveLength(1);
    const denied = first.ok ? stale : first;
    if (!denied.ok) expect(denied.error.code).toMatch(/CHALLENGE_USED|CREDENTIAL_STALE/);
    const listed = await value.identity.listPasskeys({ actor });
    if (!listed.ok) throw new Error(listed.error.code);
    expect(listed.value.map((credential) => credential.name).sort()).toEqual(
      ["Ada passkey", "Security key"].sort(),
    );
    const used = listed.value.find((credential) => credential.name === "Ada passkey");
    expect(Number(used?.lastUsedAt)).toBe(value.now());
    expect(used?.revision).toBe(2);
    expect(used?.state).toBe("ACTIVE");
    expect(
      value.database
        .query<{ signature_counter: number }, [string]>(
          "SELECT signature_counter FROM passkey_credentials WHERE id = ?",
        )
        .get(used?.id ?? ""),
    ).toEqual({ signature_counter: 1 });

    const zero = await value.identity.beginPasskeyAuthentication({
      idempotencyKey: "begin-auth-zero",
      credentialId: "credential-security-key",
    });
    if (!zero.ok) throw new Error(zero.error.code);
    const zeroCounter = await value.identity.authenticate({
      idempotencyKey: "zero-counter-valid",
      challengeId: zero.value.challengeId,
      response: {
        challenge: zero.value.challenge,
        credentialId: "credential-security-key",
        newCounter: 0,
      },
    });
    expect(zeroCounter.ok).toBe(true);

    const revoked = await value.identity.revokePasskey({
      actor,
      idempotencyKey: "revoke-security-key",
      credentialId: registered.ok ? registered.value.id : "",
      expectedRevision: registered.ok ? registered.value.revision + 1 : 0,
    });
    expect(revoked.ok).toBe(true);
    const revokedAuth = await value.identity.beginPasskeyAuthentication({
      idempotencyKey: "begin-revoked-auth",
      credentialId: "credential-security-key",
    });
    expect(revokedAuth.ok).toBe(false);
    if (!revokedAuth.ok) expect(revokedAuth.error.code).toBe("PASSKEY_NOT_FOUND");

    const staleChallenge = await value.identity.beginPasskeyAuthentication({
      idempotencyKey: "begin-stale-auth",
      credentialId: "credential-ada",
    });
    if (!staleChallenge.ok) throw new Error(staleChallenge.error.code);
    value.webAuthn.beforeAuthenticationResult = () => {
      value.database.exec(
        `UPDATE passkey_credentials
         SET revision = revision + 1, revoked_at = ${value.now()}
         WHERE credential_id = 'credential-ada'`,
      );
      value.webAuthn.beforeAuthenticationResult = undefined;
    };
    const staleRevision = await value.identity.authenticate({
      idempotencyKey: "stale-revision",
      challengeId: staleChallenge.value.challengeId,
      response: {
        challenge: staleChallenge.value.challenge,
        credentialId: "credential-ada",
        newCounter: 2,
      },
    });
    expect(staleRevision.ok).toBe(false);
    if (!staleRevision.ok) expect(staleRevision.error.code).toBe("CREDENTIAL_STALE");
  });

  test("rotates salted recovery codes and redeems exactly one into a restricted session", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const actor = {
      kind: "MEMBER",
      memberId: owner.value.memberId,
      sessionId: owner.value.id,
      sessionProof: owner.value.proof,
    } as const;
    const first = await value.identity.generateRecoveryCodes({
      actor,
      idempotencyKey: "recovery-first",
    });
    if (!first.ok) throw new Error(first.error.code);
    expect(first.value.codes).toHaveLength(8);
    for (const code of first.value.codes) expect(value.databaseText()).not.toContain(code);
    const replacement = await value.identity.generateRecoveryCodes({
      actor,
      idempotencyKey: "recovery-replacement",
    });
    if (!replacement.ok) throw new Error(replacement.error.code);
    const lostResponseRetry = await value.identity.generateRecoveryCodes({
      actor,
      idempotencyKey: "recovery-replacement",
    });
    expect(lostResponseRetry.ok).toBe(false);
    if (!lostResponseRetry.ok) expect(lostResponseRetry.error.code).toBe("SECRET_ALREADY_ISSUED");
    for (const oldCode of first.value.codes) {
      const old = await value.identity.redeemRecoveryCode({
        idempotencyKey: value.idempotencyKey("old-recovery"),
        memberId: owner.value.memberId,
        code: oldCode,
      });
      expect(old.ok).toBe(false);
      if (!old.ok) expect(old.error.code).toBe("RECOVERY_CODE_INVALID");
    }

    const code = replacement.value.codes[0] ?? "";
    const [redeemed, replay] = await Promise.all([
      value.identity.redeemRecoveryCode({
        idempotencyKey: "redeem-race-one",
        memberId: owner.value.memberId,
        code,
      }),
      value.identity.redeemRecoveryCode({
        idempotencyKey: "redeem-race-two",
        memberId: owner.value.memberId,
        code,
      }),
    ]);
    expect([redeemed.ok, replay.ok].filter(Boolean)).toHaveLength(1);
    const denied = redeemed.ok ? replay : redeemed;
    if (!denied.ok) expect(denied.error.code).toBe("RECOVERY_CODE_USED");
    const session = redeemed.ok ? redeemed.value : replay.ok ? replay.value : undefined;
    expect(session?.kind).toBe("RECOVERY");
    expect(Number(session?.expiresAt)).toBe(value.now() + 15 * 60);
    if (!session) throw new Error("recovery failed");
    const restricted = await value.identity.generateRecoveryCodes({
      actor: {
        kind: "MEMBER",
        memberId: session.memberId,
        sessionId: session.id,
        sessionProof: session.proof,
      },
      idempotencyKey: "recovery-cannot-administer",
    });
    expect(restricted.ok).toBe(false);
    if (!restricted.ok) expect(restricted.error.code).toBe("SESSION_INVALID");

    const registration = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "begin-recovery-registration",
      principal: { kind: "RECOVERY", sessionId: session.id, sessionProof: session.proof },
      displayName: "Ada",
    });
    if (!registration.ok) throw new Error(registration.error.code);
    const replacementCredential = await value.identity.finishPasskeyRegistration({
      idempotencyKey: "finish-recovery-registration",
      principal: { kind: "RECOVERY", sessionId: session.id, sessionProof: session.proof },
      challengeId: registration.value.challengeId,
      credentialName: "Recovered passkey",
      response: {
        challenge: registration.value.challenge,
        credentialId: "credential-recovered",
        counter: 0,
      },
    });
    expect(replacementCredential.ok).toBe(true);
    const consumedRecoverySession = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "begin-consumed-recovery",
      principal: { kind: "RECOVERY", sessionId: session.id, sessionProof: session.proof },
      displayName: "Ada",
    });
    expect(consumedRecoverySession.ok).toBe(false);
    if (!consumedRecoverySession.ok)
      expect(consumedRecoverySession.error.code).toBe("RECOVERY_SESSION_INVALID");
    const authentication = await value.identity.beginPasskeyAuthentication({
      idempotencyKey: "begin-recovered-auth",
      credentialId: "credential-recovered",
    });
    if (!authentication.ok) throw new Error(authentication.error.code);
    const ordinary = await value.identity.authenticate(
      value.authenticationCommand(
        authentication.value.challengeId,
        authentication.value.challenge,
        "credential-recovered",
      ),
    );
    expect(ordinary.ok).toBe(true);
    for (const raw of [...replacement.value.codes, registration.value.challenge]) {
      expect(value.databaseText()).not.toContain(raw);
    }
  });

  test("consumes challenges once, rejects exact expiry, and never persists clear challenge material", async () => {
    const value = fixture();
    const begun = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "begin-expired-bootstrap",
      principal: { kind: "BOOTSTRAP", secret: value.bootstrapSecret },
      displayName: "Ada",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    expect(value.databaseText()).not.toContain(begun.value.challenge);
    value.advance(5 * 60);
    const expired = await value.identity.bootstrap({
      idempotencyKey: "expired-bootstrap",
      bootstrapSecret: value.bootstrapSecret,
      displayName: "Ada",
      credentialName: "Laptop",
      challengeId: begun.value.challengeId,
      response: { challenge: begun.value.challenge, credentialId: "credential-ada" },
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe("CHALLENGE_EXPIRED");
  });

  test("rolls back invitation acceptance when the final write fails", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const invitation = await value.invite(owner.value);
    if (!invitation.ok) throw new Error(invitation.error.code);
    const exchange = await value.identity.exchangeInvitation({
      secret: invitation.value.secret,
      idempotencyKey: "exchange-rollback",
    });
    if (!exchange.ok) throw new Error(exchange.error.code);
    const begun = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "begin-rollback-invitation",
      principal: { kind: "INVITATION", secret: exchange.value.secret },
      displayName: "Grace",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    const unverified = await value.identity.accept({
      idempotencyKey: "accept-before-verification",
      invitationSessionSecret: exchange.value.secret,
      displayName: "Grace",
      credentialName: "Laptop",
      challengeId: "missing-challenge",
      response: {},
    });
    expect(unverified.ok).toBe(false);
    if (!unverified.ok) expect(unverified.error.code).toBe("CHALLENGE_INVALID");
    value.database.exec(`
      CREATE TRIGGER fail_accept_audit BEFORE INSERT ON audit_events
      WHEN NEW.kind = 'INVITATION_ACCEPTED'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END
    `);
    const failed = await value.identity.accept({
      idempotencyKey: "rollback-accept",
      invitationSessionSecret: exchange.value.secret,
      displayName: "Grace",
      credentialName: "Laptop",
      challengeId: begun.value.challengeId,
      response: { challenge: begun.value.challenge, credentialId: "credential-grace" },
    });
    expect(failed.ok).toBe(false);
    expect(
      value.database.query<{ count: number }, []>("SELECT count(*) AS count FROM members").get(),
    ).toEqual({ count: 1 });
    expect(
      value.database
        .query<{ consumed_at: number | null }, [string]>(
          "SELECT consumed_at FROM invitations WHERE id = ?",
        )
        .get(invitation.value.id),
    ).toEqual({ consumed_at: null });
  });
});
