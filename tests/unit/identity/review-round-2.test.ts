import { afterEach, describe, expect, test } from "bun:test";
import { IdentityIdempotency } from "../../../src/server/modules/identity/idempotency.ts";
import { sha256 } from "../../../src/server/modules/identity/recovery.ts";
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

describe("Task 3 review round two", () => {
  test("browser sessions separate public record IDs from one-time bearer proofs", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    expect(owner.value.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(owner.value.id).not.toBe(owner.value.proof);
    expect(
      value.database
        .query<{ proof_hash: Uint8Array }, [string]>("SELECT proof_hash FROM sessions WHERE id = ?")
        .get(owner.value.id)?.proof_hash,
    ).toHaveLength(32);
    expect(value.databaseText()).not.toContain(owner.value.proof);

    const wrong = await value.identity.listPasskeys({
      actor: {
        kind: "MEMBER",
        memberId: owner.value.memberId,
        sessionId: owner.value.id,
        sessionProof: "wrong-session-proof-that-is-long-enough-123",
      },
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe("SESSION_INVALID");
    const correct = await value.identity.listPasskeys({
      actor: {
        kind: "MEMBER",
        memberId: owner.value.memberId,
        sessionId: owner.value.id,
        sessionProof: owner.value.proof,
      },
    });
    expect(correct.ok).toBe(true);
    const missing = await value.identity.listPasskeys({
      actor: {
        kind: "MEMBER",
        memberId: owner.value.memberId,
        sessionId: owner.value.id,
      } as never,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("SESSION_INVALID");
  });

  test("recovery sessions require their one-time bearer proof", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const actor = {
      kind: "MEMBER" as const,
      memberId: owner.value.memberId,
      sessionId: owner.value.id,
      sessionProof: owner.value.proof,
    };
    const codes = await value.identity.generateRecoveryCodes({
      actor,
      idempotencyKey: "round-two-codes",
    });
    if (!codes.ok) throw new Error(codes.error.code);
    const session = await value.identity.redeemRecoveryCode({
      idempotencyKey: "round-two-redeem",
      memberId: owner.value.memberId,
      code: codes.value.codes[0] ?? "",
    });
    if (!session.ok) throw new Error(session.error.code);
    expect(value.databaseText()).not.toContain(session.value.proof);
    const wrong = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "wrong-recovery-proof",
      principal: {
        kind: "RECOVERY",
        sessionId: session.value.id,
        sessionProof: "wrong-recovery-proof-that-is-long-enough-123",
      },
      displayName: "Ada",
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe("RECOVERY_SESSION_INVALID");
    const correct = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "correct-recovery-proof",
      principal: {
        kind: "RECOVERY",
        sessionId: session.value.id,
        sessionProof: session.value.proof,
      },
      displayName: "Ada",
    });
    expect(correct.ok).toBe(true);
  });

  test("session-producing idempotency and audit rows never contain bearer proofs", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const begun = await value.identity.beginPasskeyAuthentication({
      idempotencyKey: "session-issue-auth-begin",
      credentialId: "credential-ada",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    const command = {
      idempotencyKey: "session-issue-auth-finish",
      challengeId: begun.value.challengeId,
      response: {
        challenge: begun.value.challenge,
        credentialId: "credential-ada",
        newCounter: 1,
      },
    } as const;
    const issued = await value.identity.authenticate(command);
    if (!issued.ok) throw new Error(issued.error.code);
    const retry = await value.identity.authenticate(command);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe("SECRET_ALREADY_ISSUED");
    const text = value.databaseText();
    expect(text).not.toContain(issued.value.proof);
    expect(
      value.database
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM audit_events WHERE subject_id = ?",
        )
        .get(issued.value.id),
    ).toEqual({ count: 0 });
  });

  test("idempotency keys are namespaced by operation", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const actor = {
      kind: "MEMBER" as const,
      memberId: owner.value.memberId,
      sessionId: owner.value.id,
      sessionProof: owner.value.proof,
    };
    const invitation = await value.identity.invite({
      actor,
      idempotencyKey: "shared-operation-key",
    });
    const recovery = await value.identity.generateRecoveryCodes({
      actor,
      idempotencyKey: "shared-operation-key",
    });
    expect(invitation.ok).toBe(true);
    expect(recovery.ok).toBe(true);
    expect(
      value.database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM idempotency_results WHERE idempotency_key LIKE '%shared-operation-key'",
        )
        .get(),
    ).toEqual({ count: 2 });
  });

  test("malformed WebAuthn responses return stable audited errors", async () => {
    for (const [index, response] of [
      null,
      42,
      "credential-ada",
      { credentialId: 42 },
      { credentialId: "x".repeat(2_000) },
      { nested: { nested: { nested: { value: "x" } } } },
    ].entries()) {
      const value = fixture();
      const owner = await value.bootstrap();
      if (!owner.ok) throw new Error(owner.error.code);
      const begun = await value.identity.beginPasskeyAuthentication({
        idempotencyKey: `malformed-begin-${index}`,
        credentialId: "credential-ada",
      });
      if (!begun.ok) throw new Error(begun.error.code);
      const result = await value.identity.authenticate({
        idempotencyKey: `malformed-finish-${index}`,
        challengeId: begun.value.challengeId,
        response,
      });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error.code).toMatch(/IDENTITY_INPUT_INVALID|PASSKEY_VERIFICATION_FAILED/);
      expect(
        value.database
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM audit_events WHERE kind = 'IDENTITY_ATTEMPT_FAILED'",
          )
          .get()?.count,
      ).toBeGreaterThan(0);
    }
  });

  test("idempotency canonicalization rejects cycles, excessive depth, and unsupported values", async () => {
    const value = fixture();
    const idempotency = new IdentityIdempotency(value.database, sha256, value.now);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 32; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    for (const [index, input] of [
      cyclic,
      deep,
      { value: Number.POSITIVE_INFINITY },
      new Date(),
    ].entries()) {
      const result = await idempotency.ticket("TEST", "BOUNDARY", `key-${index}`, input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("IDENTITY_INPUT_INVALID");
    }
  });

  test("corrupt replay rows return a stable storage error", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const actor = {
      kind: "MEMBER" as const,
      memberId: owner.value.memberId,
      sessionId: owner.value.id,
      sessionProof: owner.value.proof,
    };
    const first = await value.identity.invite({
      actor,
      idempotencyKey: "corrupt-replay",
    });
    expect(first.ok).toBe(true);
    value.database.exec(
      'UPDATE idempotency_results SET result_json = \'{"kind":"RESULT","result":{"ok":true}}\' WHERE idempotency_key LIKE \'%corrupt-replay\'',
    );
    const replay = await value.identity.invite({
      actor,
      idempotencyKey: "corrupt-replay",
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("IDEMPOTENCY_STORAGE_INVALID");
    expect(
      value.database
        .query<{ count: number }, []>(
          'SELECT count(*) AS count FROM audit_events WHERE kind = \'IDENTITY_ATTEMPT_FAILED\' AND safe_details = \'{"surface":"IDEMPOTENCY_REPLAY","code":"IDEMPOTENCY_STORAGE_INVALID"}\'',
        )
        .get()?.count,
    ).toBe(1);
  });

  test("bootstrap binding mismatch is audited", async () => {
    const value = fixture();
    const begun = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "binding-audit-begin",
      principal: { kind: "BOOTSTRAP", secret: value.bootstrapSecret },
      displayName: "Ada",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    value.database
      .query<void, [string]>(
        "UPDATE webauthn_challenges SET bootstrap_binding_hash = zeroblob(32) WHERE id = ?",
      )
      .run(begun.value.challengeId);
    const mismatch = await value.identity.bootstrap({
      idempotencyKey: "binding-audit-finish",
      bootstrapSecret: value.bootstrapSecret,
      displayName: "Ada",
      credentialName: "Laptop",
      challengeId: begun.value.challengeId,
      response: { challenge: begun.value.challenge, credentialId: "credential-ada" },
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe("CHALLENGE_INVALID");
    expect(
      value.database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM audit_events WHERE kind = 'IDENTITY_ATTEMPT_FAILED'",
        )
        .get()?.count,
    ).toBeGreaterThan(0);
  });

  test("rolled-back registration and revoke failures are audited safely", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const actor = {
      kind: "MEMBER" as const,
      memberId: owner.value.memberId,
      sessionId: owner.value.id,
      sessionProof: owner.value.proof,
    };
    const begun = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "rollback-registration-begin",
      principal: actor,
      displayName: "Ada",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    value.database.exec(`
      CREATE TRIGGER fail_registration_audit BEFORE INSERT ON audit_events
      WHEN NEW.kind = 'PASSKEY_REGISTERED'
      BEGIN SELECT RAISE(ABORT, 'injected registration failure'); END
    `);
    const registration = await value.identity.finishPasskeyRegistration({
      idempotencyKey: "rollback-registration-finish",
      principal: actor,
      challengeId: begun.value.challengeId,
      credentialName: "Should rollback",
      response: {
        challenge: begun.value.challenge,
        credentialId: "credential-rollback",
      },
    });
    expect(registration.ok).toBe(false);
    if (!registration.ok) expect(registration.error.code).toBe("IDENTITY_OPERATION_FAILED");
    expect(
      value.database
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM passkey_credentials WHERE credential_id = 'credential-rollback'",
        )
        .get(),
    ).toEqual({ count: 0 });
    value.database.exec("DROP TRIGGER fail_registration_audit");

    const credentials = await value.identity.listPasskeys({ actor });
    if (!credentials.ok) throw new Error(credentials.error.code);
    const credential = credentials.value[0];
    if (!credential) throw new Error("missing credential");
    value.database.exec(`
      CREATE TRIGGER fail_revoke_audit BEFORE INSERT ON audit_events
      WHEN NEW.kind = 'PASSKEY_REVOKED'
      BEGIN SELECT RAISE(ABORT, 'injected revoke failure'); END
    `);
    const revoked = await value.identity.revokePasskey({
      actor,
      idempotencyKey: "rollback-revoke",
      credentialId: credential.id,
      expectedRevision: credential.revision,
    });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error.code).toBe("IDENTITY_OPERATION_FAILED");
    expect(
      value.database
        .query<{ revoked_at: number | null }, [string]>(
          "SELECT revoked_at FROM passkey_credentials WHERE id = ?",
        )
        .get(credential.id),
    ).toEqual({ revoked_at: null });
    const failureDetails = value.database
      .query<{ safe_details: string }, []>(
        "SELECT safe_details FROM audit_events WHERE kind = 'IDENTITY_ATTEMPT_FAILED'",
      )
      .all()
      .map((row) => row.safe_details)
      .join("\n");
    expect(failureDetails).toContain("PASSKEY_REGISTRATION_FINISH");
    expect(failureDetails).toContain("PASSKEY_REVOKE");
    expect(failureDetails).not.toContain("injected");
  });
});
