import { useState } from "react";
import { z } from "zod";
import { browserJson } from "../../api-client.ts";
import { RegistrationPolicyFeature } from "./registration-policy-feature.tsx";
import { EmailOtpForm } from "../setup/email-otp-form.tsx";

const InviteSchema = z.object({
  ok: z.literal(true),
  value: z.object({ invitationUrl: z.string() }),
});
export function MembersFeature() {
  const [invite, setInvite] = useState<string>();
  const [emailEnrolled, setEmailEnrolled] = useState(false);
  async function create(form: FormData) {
    const result = await browserJson("/api/v1/members/invitations", InviteSchema, {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        label: String(form.get("label")),
      }),
    });
    setInvite(result.value.invitationUrl);
  }
  return (
    <>
      <header className="workspace-header">
        <div>
          <p className="utility">SETTINGS</p>
          <h1>Team & access</h1>
          <p>One trusted team, two roles, and team-wide project access.</p>
        </div>
      </header>
      <section className="summary-grid">
        <article>
          <span>MEMBERS</span>
          <strong>1</strong>
          <small>1 owner · 0 members</small>
        </article>
        <article>
          <span>PASSKEYS</span>
          <strong>1</strong>
          <small>Required for owner actions</small>
        </article>
        <article>
          <span>PENDING INVITES</span>
          <strong>{invite ? 1 : 0}</strong>
          <small>Expire automatically</small>
        </article>
      </section>
      <section className="data-panel">
        <header>
          <strong>Team members</strong>
          <form action={(form) => void create(form)} className="inline-form">
            <input name="label" placeholder="New collaborator" required />
            <button type="submit">Invite member</button>
          </form>
        </header>
        <div className="data-row">
          <div className="avatar">TK</div>
          <div>
            <strong>Tim Kraus</strong>
            <small>Owner · local passkey</small>
          </div>
          <span className="status">OWNER</span>
        </div>
        {invite ? (
          <div className="invite-result">
            <strong>Invitation created</strong>
            <code>{invite}</code>
          </div>
        ) : null}
      </section>
      <section className="data-panel" aria-labelledby="email-enrollment-title">
        <header>
          <div>
            <h2 id="email-enrollment-title">Email sign-in</h2>
            <small>Add a verified email as another local sign-in method.</small>
          </div>
        </header>
        {emailEnrolled ? (
          <p role="status">Email sign-in enrolled.</p>
        ) : (
          <EmailOtpForm
            requestPath="/api/v1/auth/email-otp/enroll/request"
            verifyPath="/api/v1/auth/email-otp/enroll/verify"
            verifyLabel="Verify and enroll email"
            onSuccess={() => setEmailEnrolled(true)}
          />
        )}
      </section>
      <RegistrationPolicyFeature />
    </>
  );
}
