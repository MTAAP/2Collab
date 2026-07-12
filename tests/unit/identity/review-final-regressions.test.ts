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

function deepResponse(challenge: string, credentialId: string, marker: string): unknown {
  const response: Record<string, unknown> = { challenge, credentialId };
  let cursor = response;
  for (let index = 0; index < 24; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.nested = next;
    cursor = next;
  }
  cursor.secret = marker;
  return response;
}

function expectCategoricalAudit(value: IdentityFixture, surface: string, marker: string): void {
  const details = value.database
    .query<{ safe_details: string }, []>(
      "SELECT safe_details FROM audit_events WHERE kind = 'IDENTITY_ATTEMPT_FAILED' ORDER BY created_at, id",
    )
    .all()
    .map((row) => row.safe_details);
  expect(details).toContain(JSON.stringify({ surface, code: "IDENTITY_INPUT_INVALID" }));
  expect(details.join("\n")).not.toContain(marker);
  expect(details.every((entry) => entry.length <= 160)).toBe(true);
}

describe("Task 3 final review regressions", () => {
  test("canonicalization preserves own __proto__ input for ordinary and null-prototype objects", async () => {
    const value = fixture();
    const idempotency = new IdentityIdempotency(value.database, sha256, value.now);
    const baseline = await idempotency.ticket("TEST", "ACTOR", "same-key", { a: 1 });
    const jsonDangerous = JSON.parse('{"a":1,"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.a = 1;
    Object.defineProperty(nullPrototype, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { polluted: true },
      writable: true,
    });
    const jsonTicket = await idempotency.ticket("TEST", "ACTOR", "same-key", jsonDangerous);
    const nullTicket = await idempotency.ticket("TEST", "ACTOR", "same-key", nullPrototype);
    expect(baseline.ok).toBe(true);
    expect(jsonTicket.ok).toBe(true);
    expect(nullTicket.ok).toBe(true);
    if (!baseline.ok || !jsonTicket.ok || !nullTicket.ok) return;
    expect(jsonTicket.value.inputHash).not.toBe(baseline.value.inputHash);
    expect(nullTicket.value.inputHash).toBe(jsonTicket.value.inputHash);
  });

  test("oversized collections are rejected before entry values are read or cloned", async () => {
    const value = fixture();
    const idempotency = new IdentityIdempotency(value.database, sha256, value.now);
    let arrayEntryRead = false;
    const oversizedArray = new Array(4_097);
    Object.defineProperty(oversizedArray, 0, {
      enumerable: true,
      get: () => {
        arrayEntryRead = true;
        return "should-not-be-read";
      },
    });
    let objectEntryRead = false;
    const oversizedObject: Record<string, unknown> = {};
    Object.defineProperty(oversizedObject, "key-0000", {
      enumerable: true,
      get: () => {
        objectEntryRead = true;
        return "should-not-be-read";
      },
    });
    for (let index = 1; index < 4_097; index += 1) {
      oversizedObject[`key-${index.toString().padStart(4, "0")}`] = index;
    }
    const arrayTicket = await idempotency.ticket("TEST", "ACTOR", "array-key", oversizedArray);
    const objectTicket = await idempotency.ticket("TEST", "ACTOR", "object-key", oversizedObject);
    expect(arrayTicket.ok).toBe(false);
    expect(objectTicket.ok).toBe(false);
    expect(arrayEntryRead).toBe(false);
    expect(objectEntryRead).toBe(false);
  });

  test("replay rejects a present but operation-incompatible success projection", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const invitation = await value.invite(owner.value, "Strict replay");
    if (!invitation.ok) throw new Error(invitation.error.code);
    const command = {
      actor: {
        kind: "MEMBER" as const,
        memberId: owner.value.memberId,
        sessionId: owner.value.id,
        sessionProof: owner.value.proof,
      },
      idempotencyKey: "strict-operation-replay",
      invitationId: invitation.value.id,
    };
    const first = await value.identity.revokeInvitation(command);
    expect(first.ok).toBe(true);
    value.database
      .query<void, [string]>(
        "UPDATE idempotency_results SET result_json = ? WHERE idempotency_key = 'INVITATION_REVOKE:strict-operation-replay'",
      )
      .run(JSON.stringify({ kind: "RESULT", result: { ok: true, value: { id: "wrong" } } }));
    const replay = await value.identity.revokeInvitation(command);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("IDEMPOTENCY_STORAGE_INVALID");
  });

  test("deep bootstrap registration responses emit a bounded categorical audit", async () => {
    const value = fixture();
    const begun = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "final-bootstrap-begin",
      principal: { kind: "BOOTSTRAP", secret: value.bootstrapSecret },
      displayName: "Ada",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    const marker = "BOOTSTRAP_RESPONSE_SECRET_MARKER";
    const result = await value.identity.bootstrap({
      idempotencyKey: "final-bootstrap-finish",
      bootstrapSecret: value.bootstrapSecret,
      displayName: "Ada",
      credentialName: "Laptop",
      challengeId: begun.value.challengeId,
      response: deepResponse(begun.value.challenge, "credential-ada", marker),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("IDENTITY_INPUT_INVALID");
    expectCategoricalAudit(value, "BOOTSTRAP", marker);
  });

  test("deep passkey registration responses emit a bounded categorical audit", async () => {
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
      idempotencyKey: "final-member-registration-begin",
      principal: actor,
      displayName: "Ada",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    const marker = "MEMBER_RESPONSE_SECRET_MARKER";
    const result = await value.identity.finishPasskeyRegistration({
      idempotencyKey: "final-member-registration-finish",
      principal: actor,
      challengeId: begun.value.challengeId,
      credentialName: "Second laptop",
      response: deepResponse(begun.value.challenge, "credential-second", marker),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("IDENTITY_INPUT_INVALID");
    expectCategoricalAudit(value, "PASSKEY_REGISTRATION_FINISH", marker);
  });

  test("deep invitation registration responses emit a bounded categorical audit", async () => {
    const value = fixture();
    const owner = await value.bootstrap();
    if (!owner.ok) throw new Error(owner.error.code);
    const invitation = await value.invite(owner.value, "Deep response invitee");
    if (!invitation.ok) throw new Error(invitation.error.code);
    const exchange = await value.identity.exchangeInvitation({
      idempotencyKey: "final-invitation-exchange",
      secret: invitation.value.secret,
    });
    if (!exchange.ok) throw new Error(exchange.error.code);
    const begun = await value.identity.beginPasskeyRegistration({
      idempotencyKey: "final-invitation-registration-begin",
      principal: { kind: "INVITATION", secret: exchange.value.secret },
      displayName: "Grace",
    });
    if (!begun.ok) throw new Error(begun.error.code);
    const marker = "INVITATION_RESPONSE_SECRET_MARKER";
    const result = await value.identity.accept({
      idempotencyKey: "final-invitation-accept",
      invitationSessionSecret: exchange.value.secret,
      displayName: "Grace",
      credentialName: "Laptop",
      challengeId: begun.value.challengeId,
      response: deepResponse(begun.value.challenge, "credential-grace", marker),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("IDENTITY_INPUT_INVALID");
    expectCategoricalAudit(value, "INVITATION_ACCEPT", marker);
  });
});
