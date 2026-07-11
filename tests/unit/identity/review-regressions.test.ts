import { afterEach, describe, expect, test } from "bun:test";
import { simpleWebAuthnPort } from "../../../src/server/modules/identity/passkeys.ts";
import { createIdentityFixture, type IdentityFixture } from "../../fixtures/identity.ts";

const fixtures: IdentityFixture[] = [];
const fixture = () => {
  const value = createIdentityFixture();
  fixtures.push(value);
  return value;
};

afterEach(() => {
  for (const value of fixtures.splice(0)) value.close();
});

describe("Task 3 review regressions", () => {
  test("the production WebAuthn adapter does not double-encode a generated challenge", async () => {
    const options = await simpleWebAuthnPort.generateRegistrationOptions({
      challenge: new Uint8Array([1, 2, 3]),
      rpName: "2Collab",
      rpId: "localhost",
      userId: new Uint8Array(32),
      userName: "member_1",
      userDisplayName: "Ada",
      excludeCredentials: [],
    });
    expect(options.challenge).toBe("AQID");
    const authentication = await simpleWebAuthnPort.generateAuthenticationOptions({
      challenge: new Uint8Array([4, 5, 6]),
      rpId: "localhost",
    });
    expect(authentication.challenge).toBe("BAUG");
  });

  test("discoverable authentication does not enumerate credentials", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const begun = await value.identity.beginPasskeyAuthentication({
      idempotencyKey: "discoverable-auth",
    });
    expect(begun.ok).toBe(true);
    const generated = value.webAuthn.authenticationInputs.find(
      (input): input is { allowCredentials?: readonly unknown[] } =>
        typeof input === "object" && input !== null && "challenge" in input,
    );
    expect(generated).not.toHaveProperty("allowCredentials");
  });

  test("credential-specific challenges persist the selected credential context", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const begun = await value.identity.beginPasskeyAuthentication({
      idempotencyKey: "specific-auth",
      credentialId: "credential-ada",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    const row = value.database
      .query<{ passkey_credential_id: string | null }, [string]>(
        "SELECT passkey_credential_id FROM webauthn_challenges WHERE id = ?",
      )
      .get(begun.value.challengeId);
    expect(row?.passkey_credential_id).toMatch(/^passkey_/);
    value.database.exec(`
      INSERT INTO passkey_credentials(
        id, member_id, credential_id, public_key, opaque_user_id, signature_counter,
        backup_eligible, backup_state, device_type, name, revision, created_at
      )
      SELECT 'passkey_other', member_id, 'credential-other', public_key, opaque_user_id, 0,
             1, 1, 'MULTI_DEVICE', 'Other', 1, created_at
      FROM passkey_credentials WHERE credential_id = 'credential-ada'
    `);
    const wrongCredential = await value.identity.authenticate({
      idempotencyKey: "specific-auth-wrong-finish",
      challengeId: begun.value.challengeId,
      response: { challenge: begun.value.challenge, credentialId: "credential-other" },
    });
    expect(wrongCredential.ok).toBe(false);
    if (!wrongCredential.ok) expect(wrongCredential.error.code).toBe("PASSKEY_VERIFICATION_FAILED");
  });

  test("the HTTP development exception is exact localhost only", () => {
    expect(() =>
      createIdentityFixture({ publicOrigin: "http://127.0.0.1:3000", rpId: "127.0.0.1" }),
    ).toThrow("IDENTITY_CONFIGURATION_INVALID");
  });

  test("ordinary invitation projections never admit a clear secret", async () => {
    const contracts = await import("../../../src/shared/contracts/identity.ts");
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const issue = await value.invite(owner.value);
    if (!issue.ok) throw new Error(issue.error.code);
    expect(contracts.TeamInvitationSchema.safeParse(issue.value).success).toBe(false);
    expect(contracts.InvitationIssueSchema.safeParse(issue.value).success).toBe(true);
  });

  test("exports strict runtime schemas for every Task 3 surface", async () => {
    const contracts = (await import("../../../src/shared/contracts/identity.ts")) as Record<
      string,
      unknown
    >;
    for (const name of [
      "BeginPasskeyAuthenticationSchema",
      "AuthenticatePasskeySchema",
      "RevokePasskeySchema",
      "ListPasskeysSchema",
      "PasskeyChallengeSchema",
      "PasskeyCredentialListSchema",
      "PasskeyRevocationSchema",
      "GenerateRecoveryCodesSchema",
      "RecoveryCodeSetSchema",
      "RedeemRecoveryCodeSchema",
      "CreateInvitationSchema",
      "InspectInvitationSchema",
      "RevokeInvitationSchema",
      "AcceptInvitationWithVerifiedIdentitySchema",
      "InvitationIssueSchema",
    ]) {
      expect(contracts[name], name).toBeDefined();
    }
  });

  test("audits failed bootstrap attempts without raw input", async () => {
    const value = fixture();
    const raw = "wrong-bootstrap-secret-that-is-long-enough";
    const denied = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "bad-bootstrap-audit",
      principal: { kind: "BOOTSTRAP", secret: raw },
      displayName: "Mallory",
    });
    expect(denied.ok).toBe(false);
    const audit = value.database
      .query<{ kind: string; safe_details: string }, []>(
        "SELECT kind, safe_details FROM audit_events ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    expect(audit?.kind).toBe("IDENTITY_ATTEMPT_FAILED");
    expect(audit?.safe_details).toContain("BOOTSTRAP_SECRET_INVALID");
    expect(value.databaseText()).not.toContain(raw);
  });

  test("audits failed authentication, invitation, and recovery attempts categorically", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const authentication = await value.identity.beginPasskeyAuthentication({
      idempotencyKey: "failed-auth-begin",
      credentialId: "credential-ada",
    });
    if (!authentication.ok) throw new Error(authentication.error.code);
    await value.identity.authenticate({
      idempotencyKey: "failed-auth-finish",
      challengeId: authentication.value.challengeId,
      response: {
        challenge: "wrong-sensitive-challenge-material",
        credentialId: "credential-ada",
      },
    });
    await value.identity.invite({
      actor: {
        kind: "MEMBER",
        memberId: "unknown" as never,
        sessionId: "hidden-session" as never,
        sessionProof: "hidden-session-proof-that-is-long-enough",
      },
      idempotencyKey: "failed-invitation",
      label: "Denied",
    });
    const recoveryRaw = "invalid-recovery-code-that-is-long-enough";
    await value.identity.redeemRecoveryCode({
      idempotencyKey: "failed-recovery",
      memberId: owner.value.memberId,
      code: recoveryRaw,
    });
    const details = value.database
      .query<{ safe_details: string }, []>(
        "SELECT safe_details FROM audit_events WHERE kind = 'IDENTITY_ATTEMPT_FAILED'",
      )
      .all()
      .map((row) => row.safe_details)
      .join("\n");
    expect(details).toContain("PASSKEY_AUTHENTICATION");
    expect(details).toContain("INVITATION_CREATE");
    expect(details).toContain("RECOVERY_REDEEM");
    expect(details).not.toContain(recoveryRaw);
    expect(details).not.toContain("hidden-session");
  });

  test("changed input under an idempotency key conflicts instead of replaying", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const actor = {
      kind: "MEMBER",
      memberId: owner.value.memberId,
      sessionId: owner.value.id,
      sessionProof: owner.value.proof,
    } as const;
    const first = await value.identity.invite({
      actor,
      idempotencyKey: "same-invitation-key",
      label: "First",
    });
    expect(first.ok).toBe(true);
    const conflict = await value.identity.invite({
      actor,
      idempotencyKey: "same-invitation-key",
      label: "Changed",
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("secret-producing retries return markers and persist no clear challenge", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const command = {
      idempotencyKey: "challenge-marker",
      credentialId: "credential-ada",
    } as const;
    const first = await value.identity.beginPasskeyAuthentication(command);
    if (!first.ok) throw new Error(first.error.code);
    const retry = await value.identity.beginPasskeyAuthentication(command);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe("SECRET_ALREADY_ISSUED");
    const stored = value.database
      .query<{ input_hash: string; result_json: string }, [string]>(
        "SELECT input_hash, result_json FROM idempotency_results WHERE idempotency_key LIKE '%' || ?",
      )
      .get(command.idempotencyKey);
    expect(stored?.input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.result_json).not.toContain(first.value.challenge);
    expect(value.databaseText()).not.toContain(first.value.challenge);
  });

  test("same non-secret write replays its original safe result", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const actor = {
      kind: "MEMBER",
      memberId: owner.value.memberId,
      sessionId: owner.value.id,
      sessionProof: owner.value.proof,
    } as const;
    const listed = await value.identity.listPasskeys({ actor });
    if (!listed.ok) throw new Error(listed.error.code);
    const credential = listed.value[0];
    if (!credential) throw new Error("missing credential");
    const command = {
      actor,
      idempotencyKey: "revoke-replay",
      credentialId: credential.id,
      expectedRevision: credential.revision,
    };
    const first = await value.identity.revokePasskey(command);
    const replay = await value.identity.revokePasskey(command);
    expect(first).toEqual(replay);
  });

  test("authentication reconciles device and backup metadata under the credential CAS", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const begun = await value.identity.beginPasskeyAuthentication({
      idempotencyKey: "metadata-auth-begin",
      credentialId: "credential-ada",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    const result = await value.identity.authenticate({
      idempotencyKey: "metadata-auth-finish",
      challengeId: begun.value.challengeId,
      response: {
        challenge: begun.value.challenge,
        credentialId: "credential-ada",
        newCounter: 1,
        deviceType: "SINGLE_DEVICE",
        backedUp: false,
      },
    });
    expect(result.ok).toBe(true);
    expect(
      value.database
        .query<
          { backup_eligible: number; backup_state: number; device_type: string; revision: number },
          []
        >(
          "SELECT backup_eligible, backup_state, device_type, revision FROM passkey_credentials WHERE credential_id = 'credential-ada'",
        )
        .get(),
    ).toEqual({
      backup_eligible: 0,
      backup_state: 0,
      device_type: "SINGLE_DEVICE",
      revision: 2,
    });
  });
});
