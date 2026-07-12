import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { z } from "zod";
import type { Result } from "../../../shared/contracts/result.ts";
import { inImmediateTransaction } from "../../db/transaction.ts";

export type RegistrationMode = "CLOSED" | "INVITE_ONLY" | "ALLOWLIST";
export type RegistrationRuleEffect = "ALLOW" | "DENY";
export type RegistrationRuleMatcher = "EMAIL" | "DOMAIN";

export type RegistrationRuleView = Readonly<{
  id: string;
  effect: RegistrationRuleEffect;
  matcher: RegistrationRuleMatcher;
  value: string;
  includeSubdomains: boolean;
  revision: number;
}>;

export type RegistrationPolicyView = Readonly<{
  mode: RegistrationMode;
  revision: number;
  rules: readonly RegistrationRuleView[];
}>;

type Authorization = Readonly<{
  allowed: boolean;
  normalizedEmail: string;
  policyRevision: number;
  authorizationKind?: "INVITATION" | "ALLOWLIST";
}>;

function error(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message, retry: "NEVER" } };
}

export function normalizeRegistrationEmail(input: string): Result<string> {
  const candidate = input.trim().toLowerCase();
  if (candidate.length > 254)
    return error("REGISTRATION_EMAIL_INVALID", "Email address is invalid.");
  const separator = candidate.lastIndexOf("@");
  if (separator <= 0 || separator !== candidate.indexOf("@"))
    return error("REGISTRATION_EMAIL_INVALID", "Email address is invalid.");
  const local = candidate.slice(0, separator);
  const rawDomain = candidate.slice(separator + 1);
  if (rawDomain.startsWith(".") || rawDomain.endsWith("."))
    return error("REGISTRATION_EMAIL_INVALID", "Email address is invalid.");
  const domain = domainToASCII(rawDomain).toLowerCase();
  const normalized = `${local}@${domain}`;
  if (
    !domain ||
    isIP(domain) !== 0 ||
    !z.hostname().safeParse(domain).success ||
    !z.email().safeParse(normalized).success ||
    normalized.length > 254
  )
    return error("REGISTRATION_EMAIL_INVALID", "Email address is invalid.");
  return { ok: true, value: normalized };
}

function normalizeRuleValue(matcher: RegistrationRuleMatcher, input: string): Result<string> {
  if (matcher === "EMAIL") return normalizeRegistrationEmail(input);
  const candidate = input.trim().toLowerCase();
  if (!candidate || candidate.includes("@") || candidate.includes("*") || candidate.includes(" "))
    return error("REGISTRATION_RULE_INVALID", "Registration rule is invalid.");
  const normalized = domainToASCII(candidate).toLowerCase();
  if (
    !normalized ||
    isIP(normalized) !== 0 ||
    normalized.length > 253 ||
    !z.hostname().safeParse(normalized).success ||
    normalized.split(".").some((label) => !label || label.length > 63)
  )
    return error("REGISTRATION_RULE_INVALID", "Registration rule is invalid.");
  return { ok: true, value: normalized };
}

export function createRegistrationPolicyService(
  input: Readonly<{
    database: Database;
    clock: () => number;
    id: (prefix: string) => string;
  }>,
) {
  const currentOwner = (memberId: string) =>
    input.database
      .query<{ id: string }, [string]>(
        "SELECT id FROM members WHERE id = ? AND role = 'OWNER' AND status = 'ACTIVE'",
      )
      .get(memberId) !== null;

  const read = (): RegistrationPolicyView => {
    const policy = input.database
      .query<{ mode: RegistrationMode; revision: number }, []>(
        "SELECT mode, revision FROM auth_registration_policy WHERE singleton = 1",
      )
      .get();
    if (!policy) throw new Error("REGISTRATION_POLICY_UNAVAILABLE");
    const rules = input.database
      .query<
        {
          id: string;
          effect: RegistrationRuleEffect;
          matcher: RegistrationRuleMatcher;
          value: string;
          include_subdomains: number;
          revision: number;
        },
        []
      >(
        `SELECT id, effect, matcher, value, include_subdomains, revision
         FROM auth_registration_rules WHERE revoked_at IS NULL
         ORDER BY effect, matcher, value, include_subdomains, id`,
      )
      .all()
      .map((rule) => ({
        id: rule.id,
        effect: rule.effect,
        matcher: rule.matcher,
        value: rule.value,
        includeSubdomains: rule.include_subdomains === 1,
        revision: rule.revision,
      }));
    return { mode: policy.mode, revision: policy.revision, rules };
  };

  const matches = (rule: RegistrationRuleView, email: string, domain: string): boolean => {
    if (rule.matcher === "EMAIL") return rule.value === email;
    return rule.value === domain || (rule.includeSubdomains && domain.endsWith(`.${rule.value}`));
  };

  const audit = (
    kind: string,
    actorMemberId: string,
    subjectId: string,
    details: Readonly<Record<string, boolean | number | string>>,
  ) =>
    input.database
      .query(
        `INSERT INTO audit_events(
           id, kind, actor_kind, actor_id, subject_id, safe_details, created_at
         ) VALUES (?, ?, 'MEMBER', ?, ?, ?, ?)`,
      )
      .run(
        input.id("audit"),
        kind,
        actorMemberId,
        subjectId,
        JSON.stringify(details),
        input.clock(),
      );

  return {
    read,

    readForOwner(actorMemberId: string): Result<RegistrationPolicyView> {
      return currentOwner(actorMemberId)
        ? { ok: true, value: read() }
        : error("REGISTRATION_POLICY_OWNER_REQUIRED", "Owner authority is required.");
    },

    authorize(
      request: Readonly<{ email: string; invitationActive?: boolean }>,
    ): Result<Authorization> {
      const normalized = normalizeRegistrationEmail(request.email);
      if (!normalized.ok) return normalized;
      const policy = read();
      const domain = normalized.value.slice(normalized.value.lastIndexOf("@") + 1);
      const denied = policy.rules.some(
        (rule) => rule.effect === "DENY" && matches(rule, normalized.value, domain),
      );
      const allowedByRule = policy.rules.some(
        (rule) => rule.effect === "ALLOW" && matches(rule, normalized.value, domain),
      );
      const authorizationKind =
        !denied && policy.mode !== "CLOSED" && request.invitationActive
          ? "INVITATION"
          : !denied && policy.mode === "ALLOWLIST" && allowedByRule
            ? "ALLOWLIST"
            : undefined;
      return {
        ok: true,
        value: {
          allowed: authorizationKind !== undefined,
          normalizedEmail: normalized.value,
          policyRevision: policy.revision,
          ...(authorizationKind ? { authorizationKind } : {}),
        },
      };
    },

    updateMode(
      request: Readonly<{
        actorMemberId: string;
        expectedRevision: number;
        mode: RegistrationMode;
      }>,
    ): Result<RegistrationPolicyView> {
      if (!currentOwner(request.actorMemberId))
        return error("REGISTRATION_POLICY_OWNER_REQUIRED", "Owner authority is required.");
      const changed = input.database
        .query(
          `UPDATE auth_registration_policy
           SET mode = ?, revision = revision + 1, updated_by_member_id = ?, updated_at = ?
           WHERE singleton = 1 AND revision = ?`,
        )
        .run(request.mode, request.actorMemberId, input.clock(), request.expectedRevision);
      if (changed.changes !== 1)
        return error(
          "REGISTRATION_POLICY_STALE",
          "Registration policy changed. Refresh and retry.",
        );
      audit("REGISTRATION_POLICY_CHANGED", request.actorMemberId, "REGISTRATION_POLICY", {
        mode: request.mode,
        revision: request.expectedRevision + 1,
      });
      return { ok: true, value: read() };
    },

    addRule(
      request: Readonly<{
        actorMemberId: string;
        expectedPolicyRevision: number;
        effect: RegistrationRuleEffect;
        matcher: RegistrationRuleMatcher;
        value: string;
        includeSubdomains: boolean;
      }>,
    ): Result<Readonly<{ policyRevision: number; rule: RegistrationRuleView }>> {
      if (!currentOwner(request.actorMemberId))
        return error("REGISTRATION_POLICY_OWNER_REQUIRED", "Owner authority is required.");
      if (request.matcher === "EMAIL" && request.includeSubdomains)
        return error("REGISTRATION_RULE_INVALID", "Registration rule is invalid.");
      const normalized = normalizeRuleValue(request.matcher, request.value);
      if (!normalized.ok) return normalized;
      const ruleId = input.id("registration_rule");
      try {
        return inImmediateTransaction(input.database, () => {
          const policy = input.database
            .query(
              `UPDATE auth_registration_policy
               SET revision = revision + 1, updated_by_member_id = ?, updated_at = ?
               WHERE singleton = 1 AND revision = ?`,
            )
            .run(request.actorMemberId, input.clock(), request.expectedPolicyRevision);
          if (policy.changes !== 1) throw new Error("REGISTRATION_POLICY_STALE");
          input.database
            .query(
              `INSERT INTO auth_registration_rules(
                 id, effect, matcher, value, include_subdomains, revision,
                 created_by_member_id, created_at
               ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              ruleId,
              request.effect,
              request.matcher,
              normalized.value,
              request.includeSubdomains ? 1 : 0,
              request.actorMemberId,
              input.clock(),
            );
          audit("REGISTRATION_RULE_ADDED", request.actorMemberId, ruleId, {
            effect: request.effect,
            matcher: request.matcher,
            includeSubdomains: request.includeSubdomains,
            valueDigest: createHash("sha256").update(normalized.value).digest("hex"),
          });
          return {
            ok: true as const,
            value: {
              policyRevision: request.expectedPolicyRevision + 1,
              rule: {
                id: ruleId,
                effect: request.effect,
                matcher: request.matcher,
                value: normalized.value,
                includeSubdomains: request.includeSubdomains,
                revision: 1,
              },
            },
          };
        });
      } catch (cause) {
        if (cause instanceof Error && cause.message === "REGISTRATION_POLICY_STALE")
          return error(
            "REGISTRATION_POLICY_STALE",
            "Registration policy changed. Refresh and retry.",
          );
        return error(
          "REGISTRATION_RULE_CONFLICT",
          "Registration rule conflicts with an active rule.",
        );
      }
    },

    revokeRule(
      request: Readonly<{
        actorMemberId: string;
        expectedPolicyRevision: number;
        ruleId: string;
      }>,
    ): Result<RegistrationPolicyView> {
      if (!currentOwner(request.actorMemberId))
        return error("REGISTRATION_POLICY_OWNER_REQUIRED", "Owner authority is required.");
      try {
        return inImmediateTransaction(input.database, () => {
          const policy = input.database
            .query(
              `UPDATE auth_registration_policy
               SET revision = revision + 1, updated_by_member_id = ?, updated_at = ?
               WHERE singleton = 1 AND revision = ?`,
            )
            .run(request.actorMemberId, input.clock(), request.expectedPolicyRevision);
          if (policy.changes !== 1) throw new Error("REGISTRATION_POLICY_STALE");
          const rule = input.database
            .query(
              `UPDATE auth_registration_rules
               SET revoked_at = ?, revision = revision + 1
               WHERE id = ? AND revoked_at IS NULL`,
            )
            .run(input.clock(), request.ruleId);
          if (rule.changes !== 1) throw new Error("REGISTRATION_RULE_INVALID");
          audit("REGISTRATION_RULE_REVOKED", request.actorMemberId, request.ruleId, {});
          return { ok: true as const, value: read() };
        });
      } catch (cause) {
        if (cause instanceof Error && cause.message === "REGISTRATION_POLICY_STALE")
          return error(
            "REGISTRATION_POLICY_STALE",
            "Registration policy changed. Refresh and retry.",
          );
        return error("REGISTRATION_RULE_INVALID", "Registration rule is invalid.");
      }
    },
  };
}

export type RegistrationPolicyService = ReturnType<typeof createRegistrationPolicyService>;
