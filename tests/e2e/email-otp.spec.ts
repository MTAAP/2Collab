import { expect, test } from "@playwright/test";

const requestValue = { ok: true, value: { expiresAt: 2_000, resendAt: 1_060 } };

test("returning member retries OTP verification without requesting another code", async ({
  page,
}) => {
  let requests = 0;
  let verifies = 0;
  await page.route("**/api/v1/auth/email-otp/request", async (route) => {
    requests += 1;
    expect(route.request().postDataJSON()).toEqual({
      email: "member@example.com",
      displayName: "Returning Member",
    });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(requestValue) });
  });
  await page.route("**/api/v1/auth/email-otp/verify", async (route) => {
    verifies += 1;
    expect(route.request().postDataJSON()).toEqual({ email: "member@example.com", otp: "123456" });
    if (verifies === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "TEMPORARY_FAILURE", message: "Try again." } }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, value: { authenticated: true } }),
    });
  });

  await page.goto("/login?returnTo=%2Frunners");
  await page.getByRole("radio", { name: "Email code" }).check();
  await page.getByLabel("Your name").fill("Returning Member");
  await page.getByLabel("Email address").fill("member@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  const otp = page.getByLabel("Six-digit code");
  await expect(otp).toBeFocused();
  await otp.fill("123456");
  await page.getByRole("button", { name: "Verify code" }).click();
  await page.getByRole("button", { name: "Retry verification" }).click();
  await expect(page).toHaveURL(/\/runners$/);
  expect(requests).toBe(1);
  expect(verifies).toBe(2);
});

test("login retains the passkey fallback", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("radio", { name: "Passkey" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Use passkey" })).toBeVisible();
});

test("invitation email path clears its fragment and verifies one code", async ({ page }) => {
  const secret = "invitation-secret-with-at-least-thirty-two-bytes";
  await page.route("**/api/v1/invitations/exchange", async (route) => {
    expect(new URL(page.url()).hash).toBe("");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: {
          invitationId: "invite_1",
          expiresAt: 1_900,
          invitation: {
            id: "invite_1",
            inviterDisplayName: "Owner",
            role: "MEMBER",
            expiresAt: 2_000,
          },
        },
      }),
    });
  });
  await page.route("**/api/v1/invitations/auth/email-otp/request", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      email: "invitee@example.com",
      displayName: "Invitee",
    });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(requestValue) });
  });
  await page.route("**/api/v1/invitations/auth/email-otp/verify", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ email: "invitee@example.com", otp: "654321" });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, value: { authenticated: true } }),
    });
  });
  await page.goto(`/join#${secret}`);
  await page.getByRole("radio", { name: "Email code" }).check();
  await page.getByLabel("Your name").fill("Invitee");
  await page.getByLabel("Email address").fill("invitee@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("Six-digit code").fill("654321");
  await page.getByRole("button", { name: "Verify code and join" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("owner manages registration policy and stale revisions refresh", async ({ page }) => {
  let revision = 1;
  let mode = "INVITE_ONLY";
  let staleOnce = true;
  let rules: Array<Record<string, unknown>> = [];
  const view = () => ({ ok: true, value: { mode, revision, emailLoginEnabled: true, rules } });
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        session: { id: "s" },
        user: { id: "u", name: "Owner", email: "owner@identity.invalid" },
      }),
    }),
  );
  await page.route("**/api/v1/settings/auth/registration-policy", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(view()) });
    if (staleOnce) {
      staleOnce = false;
      revision = 2;
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "REGISTRATION_POLICY_STALE", message: "Policy changed." },
        }),
      });
    }
    mode = (route.request().postDataJSON() as { mode: string }).mode;
    revision += 1;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(view()) });
  });
  await page.route("**/api/v1/settings/auth/registration-policy/rules", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body).toEqual({
      expectedPolicyRevision: 3,
      matcher: "DOMAIN",
      effect: "DENY",
      value: "Example.COM",
      includeSubdomains: true,
    });
    revision += 1;
    rules = [
      {
        id: "rule_1",
        matcher: "DOMAIN",
        effect: "DENY",
        value: "example.com",
        includeSubdomains: true,
        revision: 1,
      },
    ];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(view()) });
  });
  await page.route("**/api/v1/settings/auth/registration-policy/rules/rule_1", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    expect(route.request().postDataJSON()).toEqual({ expectedPolicyRevision: 4 });
    revision += 1;
    rules = [];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(view()) });
  });
  await page.goto("/settings/team");
  await expect(page.getByRole("heading", { name: "Registration policy" })).toBeVisible();
  await page.getByLabel("Allowlist").check();
  await page.getByRole("button", { name: "Save registration mode" }).click();
  await expect(page.getByRole("alert")).toContainText("changed");
  await page.getByRole("button", { name: "Save registration mode" }).click();
  await expect(page.getByText("Email delivery is enabled")).toBeVisible();
  await page.getByLabel("Rule type").selectOption("DOMAIN");
  await page.getByLabel("Effect").selectOption("DENY");
  await page.getByLabel("Exact email or domain").fill("Example.COM");
  await page.getByLabel("Include subdomains").check();
  await page.getByRole("button", { name: "Add rule" }).click();
  await expect(page.getByRole("cell", { name: "example.com", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Revoke example.com" }).click();
  await expect(page.getByRole("cell", { name: "example.com", exact: true })).not.toBeVisible();
});

test("member denial is bounded on the policy surface", async ({ page }) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        session: { id: "s" },
        user: { id: "u", name: "Member", email: "member@identity.invalid" },
      }),
    }),
  );
  await page.route("**/api/v1/settings/auth/registration-policy", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "REGISTRATION_POLICY_OWNER_REQUIRED", message: "Owner access is required." },
      }),
    }),
  );
  await page.goto("/settings/team");
  await expect(page.getByText("Registration policy is available to owners only.")).toBeVisible();
});

test("authenticated member enrolls a verified email sign-in method", async ({ page }) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        session: { id: "s" },
        user: { id: "u", name: "Member", email: "member@identity.invalid" },
      }),
    }),
  );
  await page.route("**/api/v1/settings/auth/registration-policy", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "REGISTRATION_POLICY_OWNER_REQUIRED", message: "Owner access is required." },
      }),
    }),
  );
  await page.route("**/api/v1/auth/email-otp/enroll/request", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ email: "member@example.com" });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(requestValue) });
  });
  await page.route("**/api/v1/auth/email-otp/enroll/verify", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ email: "member@example.com", otp: "112233" });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, value: { enrolled: true } }),
    });
  });
  await page.goto("/settings/team");
  await page.getByLabel("Email address").fill("member@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("Six-digit code").fill("112233");
  await page.getByRole("button", { name: "Verify and enroll email" }).click();
  await expect(page.getByText("Email sign-in enrolled.")).toBeVisible();
});
