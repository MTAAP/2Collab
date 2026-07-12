import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { browserJson } from "../../api-client.ts";

const Rule = z.object({
  id: z.string(),
  matcher: z.enum(["EMAIL", "DOMAIN"]),
  effect: z.enum(["ALLOW", "DENY"]),
  value: z.string(),
  includeSubdomains: z.boolean(),
  revision: z.number(),
});
const Policy = z.object({
  ok: z.literal(true),
  value: z.object({
    mode: z.enum(["CLOSED", "INVITE_ONLY", "ALLOWLIST"]),
    revision: z.number(),
    emailLoginEnabled: z.boolean(),
    rules: z.array(Rule),
  }),
});
type PolicyView = z.infer<typeof Policy>["value"];

export function RegistrationPolicyFeature() {
  const [policy, setPolicy] = useState<PolicyView>();
  const [draftMode, setDraftMode] = useState<PolicyView["mode"]>("INVITE_ONLY");
  const [state, setState] = useState<"LOADING" | "READY" | "SAVING" | "DENIED">("LOADING");
  const [message, setMessage] = useState<string>();

  const load = useCallback(async () => {
    setState("LOADING");
    try {
      const result = await browserJson("/api/v1/settings/auth/registration-policy", Policy);
      setPolicy(result.value);
      setDraftMode(result.value.mode);
      setState("READY");
    } catch (cause) {
      if (cause instanceof Error && cause.message === "REGISTRATION_POLICY_OWNER_REQUIRED")
        setState("DENIED");
      else {
        setMessage("Registration policy could not be loaded.");
        setState("READY");
      }
    }
  }, []);

  useEffect(() => void load(), [load]);

  async function mutation(path: string, method: "PUT" | "POST" | "DELETE", body: unknown) {
    if (!policy) return;
    setState("SAVING");
    setMessage(undefined);
    try {
      await browserJson(path, z.object({ ok: z.literal(true), value: z.unknown() }), {
        method,
        body: JSON.stringify(body),
      });
      await load();
    } catch (cause) {
      if (cause instanceof Error && cause.message === "REGISTRATION_POLICY_STALE") {
        setMessage("Registration policy changed. The latest revision has been loaded.");
        await load();
      } else {
        setMessage("Registration policy could not be updated.");
        setState("READY");
      }
    }
  }

  if (state === "DENIED") return <p>Registration policy is available to owners only.</p>;
  return (
    <section className="data-panel" aria-labelledby="registration-policy-title">
      <header>
        <div>
          <h2 id="registration-policy-title">Registration policy</h2>
          <small>
            {policy?.emailLoginEnabled
              ? "Email delivery is enabled"
              : "Email delivery is not configured"}
          </small>
        </div>
      </header>
      {message ? <p role="alert">{message}</p> : null}
      {policy ? (
        <>
          <fieldset disabled={state === "SAVING"}>
            <legend>Who may register a new member?</legend>
            {(["CLOSED", "INVITE_ONLY", "ALLOWLIST"] as const).map((mode) => (
              <label key={mode}>
                <input
                  type="radio"
                  name="registration-mode"
                  checked={draftMode === mode}
                  onChange={() => setDraftMode(mode)}
                />
                {mode === "CLOSED"
                  ? "Closed"
                  : mode === "INVITE_ONLY"
                    ? "Invite only"
                    : "Allowlist"}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            disabled={state === "SAVING"}
            onClick={() =>
              void mutation("/api/v1/settings/auth/registration-policy", "PUT", {
                expectedRevision: policy.revision,
                mode: draftMode,
              })
            }
          >
            Save registration mode
          </button>
          <form
            action={(form) =>
              void mutation("/api/v1/settings/auth/registration-policy/rules", "POST", {
                expectedPolicyRevision: policy.revision,
                matcher: String(form.get("kind")),
                effect: String(form.get("effect")),
                value: String(form.get("value")),
                includeSubdomains: form.get("includeSubdomains") === "on",
              })
            }
          >
            <fieldset disabled={state === "SAVING"}>
              <legend>Add exact registration rule</legend>
              <label>
                Rule type
                <select name="kind">
                  <option value="EMAIL">Email</option>
                  <option value="DOMAIN">Domain</option>
                </select>
              </label>
              <label>
                Effect
                <select name="effect">
                  <option value="ALLOW">Allow</option>
                  <option value="DENY">Deny</option>
                </select>
              </label>
              <label>
                Exact email or domain
                <input name="value" required />
              </label>
              <label>
                <input type="checkbox" name="includeSubdomains" />
                Include subdomains
              </label>
              <button type="submit">Add rule</button>
            </fieldset>
          </form>
          <table>
            <caption>Active email registration rules</caption>
            <thead>
              <tr>
                <th scope="col">Effect</th>
                <th scope="col">Type</th>
                <th scope="col">Value</th>
                <th scope="col">Scope</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {policy.rules.map((rule) => (
                <tr key={rule.id}>
                  <td>{rule.effect === "ALLOW" ? "Allow" : "Deny"}</td>
                  <td>{rule.matcher === "EMAIL" ? "Email" : "Domain"}</td>
                  <td>{rule.value}</td>
                  <td>{rule.includeSubdomains ? "Exact and subdomains" : "Exact only"}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() =>
                        void mutation(
                          `/api/v1/settings/auth/registration-policy/rules/${encodeURIComponent(rule.id)}`,
                          "DELETE",
                          { expectedPolicyRevision: policy.revision },
                        )
                      }
                    >
                      Revoke {rule.value}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : state === "LOADING" ? (
        <p aria-live="polite">Loading registration policy…</p>
      ) : null}
    </section>
  );
}
