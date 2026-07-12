import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../../../src/server/db/migrate.ts";
import {
  createRegistrationPolicyService,
  normalizeRegistrationEmail,
} from "../../../src/server/modules/identity/registration-policy.ts";

function fixture() {
  const database = new Database(":memory:", { strict: true });
  migrate(database);
  database.exec(`
    INSERT INTO deployments(id, singleton, team_id, revision, created_at)
    VALUES ('deployment_1', 1, 'team_1', 1, 100);
    INSERT INTO members(id, display_name, role, status, authority_epoch, revision, created_at)
    VALUES
      ('owner_1', 'Owner', 'OWNER', 'ACTIVE', 1, 1, 100),
      ('member_1', 'Member', 'MEMBER', 'ACTIVE', 1, 1, 100);
  `);
  let sequence = 0;
  const service = createRegistrationPolicyService({
    database,
    clock: () => 2_000_000_000,
    id: (prefix) => `${prefix}_${++sequence}`,
  });
  return { database, service };
}

describe("verified-email registration policy", () => {
  test("normalizes case and IDNA without collapsing plus aliases", () => {
    expect(normalizeRegistrationEmail("  User+Ops@BÜCHER.example ")).toEqual({
      ok: true,
      value: "user+ops@xn--bcher-kva.example",
    });
    expect(normalizeRegistrationEmail("missing-domain@").ok).toBe(false);
    expect(normalizeRegistrationEmail("two@@example.com").ok).toBe(false);
    expect(normalizeRegistrationEmail("person@[127.0.0.1]").ok).toBe(false);
    expect(normalizeRegistrationEmail("person@127.0.0.1").ok).toBe(false);
    expect(normalizeRegistrationEmail("person@.example.com").ok).toBe(false);
    expect(normalizeRegistrationEmail("person@example.com.").ok).toBe(false);
    expect(normalizeRegistrationEmail("person@example..com").ok).toBe(false);
  });

  test("defaults to invite-only and CLOSED denies even an active invitation", () => {
    const { database, service } = fixture();
    const email = "invitee@example.com";
    expect(service.authorize({ email })).toMatchObject({ ok: true, value: { allowed: false } });
    expect(service.authorize({ email, invitationActive: true })).toMatchObject({
      ok: true,
      value: { allowed: true, authorizationKind: "INVITATION" },
    });
    expect(
      service.updateMode({ actorMemberId: "owner_1", expectedRevision: 1, mode: "CLOSED" }),
    ).toMatchObject({ ok: true, value: { mode: "CLOSED", revision: 2 } });
    expect(service.authorize({ email, invitationActive: true })).toMatchObject({
      ok: true,
      value: { allowed: false },
    });
    database.close();
  });

  test("enforces exact email/domain matching, explicit subdomains, and deny precedence", () => {
    const { database, service } = fixture();
    expect(
      service.updateMode({ actorMemberId: "owner_1", expectedRevision: 1, mode: "ALLOWLIST" }),
    ).toMatchObject({ ok: true });
    expect(
      service.addRule({
        actorMemberId: "owner_1",
        expectedPolicyRevision: 2,
        effect: "ALLOW",
        matcher: "DOMAIN",
        value: "example.com",
        includeSubdomains: false,
      }),
    ).toMatchObject({ ok: true, value: { policyRevision: 3 } });
    expect(service.authorize({ email: "person@example.com" })).toMatchObject({
      ok: true,
      value: { allowed: true, authorizationKind: "ALLOWLIST", policyRevision: 3 },
    });
    expect(service.authorize({ email: "person@sub.example.com" })).toMatchObject({
      ok: true,
      value: { allowed: false },
    });
    expect(
      service.addRule({
        actorMemberId: "owner_1",
        expectedPolicyRevision: 3,
        effect: "ALLOW",
        matcher: "DOMAIN",
        value: "partners.example",
        includeSubdomains: true,
      }),
    ).toMatchObject({ ok: true, value: { policyRevision: 4 } });
    expect(service.authorize({ email: "person@deep.partners.example" })).toMatchObject({
      ok: true,
      value: { allowed: true, authorizationKind: "ALLOWLIST" },
    });
    expect(
      service.addRule({
        actorMemberId: "owner_1",
        expectedPolicyRevision: 4,
        effect: "ALLOW",
        matcher: "EMAIL",
        value: "special@sub.example.com",
        includeSubdomains: false,
      }),
    ).toMatchObject({ ok: true, value: { policyRevision: 5 } });
    expect(
      service.addRule({
        actorMemberId: "owner_1",
        expectedPolicyRevision: 5,
        effect: "DENY",
        matcher: "EMAIL",
        value: "special@sub.example.com",
        includeSubdomains: false,
      }),
    ).toMatchObject({ ok: true, value: { policyRevision: 6 } });
    expect(service.authorize({ email: "special@sub.example.com" })).toMatchObject({
      ok: true,
      value: { allowed: false },
    });
    database.close();
  });

  test("requires a current owner and revision-guards every policy mutation", () => {
    const { database, service } = fixture();
    expect(
      service.updateMode({ actorMemberId: "member_1", expectedRevision: 1, mode: "ALLOWLIST" }),
    ).toMatchObject({ ok: false, error: { code: "REGISTRATION_POLICY_OWNER_REQUIRED" } });
    expect(
      service.updateMode({ actorMemberId: "owner_1", expectedRevision: 2, mode: "ALLOWLIST" }),
    ).toMatchObject({ ok: false, error: { code: "REGISTRATION_POLICY_STALE" } });
    expect(service.read()).toMatchObject({ mode: "INVITE_ONLY", revision: 1, rules: [] });
    database.close();
  });

  test("rejects IP literals and malformed domain rules", () => {
    const { database, service } = fixture();
    for (const value of ["127.0.0.1", "[::1]", ".example.com", "example..com"]) {
      expect(
        service.addRule({
          actorMemberId: "owner_1",
          expectedPolicyRevision: 1,
          effect: "ALLOW",
          matcher: "DOMAIN",
          value,
          includeSubdomains: false,
        }),
      ).toMatchObject({ ok: false, error: { code: "REGISTRATION_RULE_INVALID" } });
    }
    database.close();
  });
});
