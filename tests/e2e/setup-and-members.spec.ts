import { expect, test } from "@playwright/test";

const base64url = (value: string) => Buffer.from(value).toString("base64url");

async function installVirtualPasskey(page: import("@playwright/test").Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
}

async function mockPasskeyAuthentication(page: import("@playwright/test").Page) {
  await page.route("**/api/auth/passkey/generate-authenticate-options", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        challenge: base64url("foundation-authentication-challenge"),
        rpId: "localhost",
        timeout: 60_000,
        userVerification: "required",
        allowCredentials: [],
      }),
    });
  });
  await page.route("**/api/auth/passkey/verify-authentication", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      response: { type: "public-key" },
    });
    await route.fulfill({
      contentType: "application/json",
      headers: {
        "set-cookie":
          "better-auth.session_token=opaque-session-token; Path=/; HttpOnly; SameSite=Strict",
      },
      body: JSON.stringify({
        session: {
          id: "session_1",
          userId: "member_1",
          expiresAt: new Date(1e13),
        },
        user: {
          id: "member_1",
          name: "Tim",
          email: "member_1@identity.invalid",
        },
      }),
    });
  });
}

test("empty deployment bootstrap registers the owner with Better Auth and signs in", async ({
  page,
}) => {
  await installVirtualPasskey(page);
  const registrationContext = `registration-context-${"r".repeat(32)}`;
  let setupRegistrations = 0;
  let setupCompletions = 0;

  await page.route("**/api/v1/bootstrap/auth/begin", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      displayName: "Tim",
      bootstrapSecret: "b".repeat(32),
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: { registrationContext, memberId: "member_1", expiresAt: 300 },
      }),
    });
  });
  await page.route("**/api/auth/passkey/generate-register-options**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("context")).toBe(registrationContext);
    expect(url.searchParams.get("name")).toBe("Tim's Mac");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        rp: { id: "localhost", name: "Collab" },
        user: {
          id: base64url("foundation-owner"),
          name: "member_1",
          displayName: "Tim",
        },
        challenge: base64url("foundation-registration-challenge"),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        timeout: 60_000,
        attestation: "none",
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
      }),
    });
  });
  await page.route("**/api/auth/passkey/verify-registration", async (route) => {
    setupRegistrations += 1;
    expect(route.request().postDataJSON()).toMatchObject({
      name: "Tim's Mac",
      response: { type: "public-key" },
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "passkey_1",
        name: "Tim's Mac",
        userId: "member_1",
      }),
    });
  });
  await page.route("**/api/v1/bootstrap/auth/complete", async (route) => {
    setupCompletions += 1;
    expect(route.request().postDataJSON()).toEqual({ registrationContext });
    if (setupCompletions === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "TEMPORARY_FAILURE", message: "Try again." } }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: { memberId: "member_1", readyToSignIn: true },
      }),
    });
  });
  await mockPasskeyAuthentication(page);

  await page.goto("/setup");
  await page.getByLabel("Bootstrap secret").fill("b".repeat(32));
  await page.getByLabel("Your name").fill("Tim");
  await page.getByLabel("Passkey name").fill("Tim's Mac");
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByRole("button", { name: "Retry setup completion" }).click();

  await expect(page.getByRole("heading", { name: "Your team is ready" })).toBeVisible();
  expect(setupRegistrations).toBe(1);
  expect(setupCompletions).toBe(2);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).not.toContain("collab_csrf");
  expect(await page.textContent("body")).not.toContain("opaque-session-token");

  await page.goto("/login?returnTo=%2Frunners");
  await page.getByRole("button", { name: "Use passkey" }).click();
  await expect(page).toHaveURL(/\/runners$/);
});

test("invitation fragment is cleared before exchange and becomes an HttpOnly join cookie", async ({
  context,
  page,
}) => {
  const secret = "single-use-invitation-fragment-secret";
  let exchangedSecret: string | undefined;
  await page.route("**/api/v1/invitations/exchange", async (route) => {
    exchangedSecret = (route.request().postDataJSON() as { secret: string }).secret;
    expect(new URL(page.url()).hash).toBe("");
    await route.fulfill({
      contentType: "application/json",
      headers: {
        "set-cookie":
          "collab_invitation=exchange-session-secret; Path=/api/v1/invitations; HttpOnly; SameSite=Strict",
      },
      body: JSON.stringify({
        ok: true,
        value: {
          invitationId: "invite_1",
          expiresAt: 900,
          invitation: {
            id: "invite_1",
            inviterDisplayName: "Owner",
            role: "MEMBER",
            expiresAt: 1_800,
          },
        },
      }),
    });
  });

  await page.goto(`/join#${secret}`);
  await expect(page.getByRole("heading", { name: "Join Foundation team" })).toBeVisible();
  expect(exchangedSecret).toBe(secret);
  expect(new URL(page.url()).hash).toBe("");
  expect(await page.evaluate(() => document.cookie)).not.toContain("collab_invitation");
  const invitationCookie = (await context.cookies()).find(
    (cookie) => cookie.name === "collab_invitation",
  );
  expect(invitationCookie).toMatchObject({
    httpOnly: true,
    path: "/api/v1/invitations",
    sameSite: "Strict",
  });
});

test("invitee registers a Better Auth passkey before the member is activated", async ({ page }) => {
  await installVirtualPasskey(page);
  await mockPasskeyAuthentication(page);
  const secret = "single-use-invitation-fragment-secret";
  const registrationContext = `invitation-registration-${"i".repeat(32)}`;
  let invitationRegistrations = 0;
  let invitationCompletions = 0;
  await page.route("**/api/v1/invitations/exchange", async (route) => {
    expect(new URL(page.url()).hash).toBe("");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: {
          invitationId: "invitation_1",
          expiresAt: 1_900,
          invitation: {
            id: "invitation_1",
            inviterDisplayName: "Owner",
            role: "MEMBER",
            expiresAt: 2_000,
          },
        },
      }),
    });
  });
  await page.route("**/api/v1/invitations/auth/begin", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ displayName: "Invitee" });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: {
          registrationContext,
          memberId: "member_invitee",
          expiresAt: 1_300,
          invitation: {
            id: "invitation_1",
            inviterDisplayName: "Owner",
            role: "MEMBER",
            expiresAt: 2_000,
          },
        },
      }),
    });
  });
  await page.route("**/api/auth/passkey/generate-register-options**", async (route) => {
    expect(new URL(route.request().url()).searchParams.get("context")).toBe(registrationContext);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        rp: { id: "localhost", name: "Collab" },
        user: { id: base64url("member-invitee"), name: "member_invitee", displayName: "Invitee" },
        challenge: base64url("invitation-registration-challenge"),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        timeout: 60_000,
        attestation: "none",
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
      }),
    });
  });
  await page.route("**/api/auth/passkey/verify-registration", async (route) => {
    invitationRegistrations += 1;
    expect(route.request().postDataJSON()).toMatchObject({
      name: "Invitee's Mac",
      response: { type: "public-key" },
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "passkey_invitee",
        name: "Invitee's Mac",
        userId: "member_invitee",
      }),
    });
  });
  await page.route("**/api/v1/invitations/auth/complete", async (route) => {
    invitationCompletions += 1;
    expect(route.request().postDataJSON()).toEqual({ registrationContext });
    if (invitationCompletions === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "TEMPORARY_FAILURE", message: "Try again." } }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: { memberId: "member_invitee", readyToSignIn: true },
      }),
    });
  });

  await page.goto(`/join#${secret}`);
  await expect(page.getByText("Invited by Owner")).toBeVisible();
  await expect(page.getByText("Role: Member")).toBeVisible();
  await page.getByLabel("Your name").fill("Invitee");
  await page.getByLabel("Passkey name").fill("Invitee's Mac");
  await page.getByRole("button", { name: "Register passkey and join" }).click();
  await page.getByRole("button", { name: "Retry invitation completion" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(invitationRegistrations).toBe(1);
  expect(invitationCompletions).toBe(2);
});

test("signed-in owner claims and approves the exact CLI user code", async ({ page }) => {
  await page.route("**/api/auth/get-session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          id: "session_1",
          userId: "member_1",
          expiresAt: new Date(1e13),
        },
        user: {
          id: "member_1",
          name: "Tim",
          email: "member_1@identity.invalid",
        },
      }),
    });
  });
  await page.route("**/api/auth/device?user_code=ABCD-1234", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ user_code: "ABCD-1234", status: "pending" }),
    });
  });
  await page.route("**/api/auth/device/approve", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ userCode: "ABCD-1234" });
    expect(route.request().headers()).not.toHaveProperty("x-collab-csrf");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });

  await page.goto("/device?user_code=ABCD-1234");
  await expect(page.getByRole("heading", { name: "Authorize this CLI device?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Authorize device" })).toBeEnabled();
  await page.getByRole("button", { name: "Authorize device" }).click();
  await expect(page.getByText("CLI device authorized")).toBeVisible();
});

test("device authorization preserves its user code across passkey sign-in", async ({ page }) => {
  await page.route("**/api/auth/get-session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    });
  });
  await page.goto("/device?user_code=ABCD-1234");
  await expect(page.getByRole("link", { name: "Sign in with your passkey first" })).toHaveAttribute(
    "href",
    "/login?returnTo=%2Fdevice%3Fuser_code%3DABCD-1234",
  );
});

test("host recovery clears its fragment before registering the replacement passkey", async ({
  page,
}) => {
  await installVirtualPasskey(page);
  await mockPasskeyAuthentication(page);
  const registrationContext = `recovery-context-${"x".repeat(32)}`;
  let recoveryRegistrations = 0;
  let recoveryCompletions = 0;
  await page.route("**/api/auth/passkey/generate-register-options**", async (route) => {
    expect(new URL(page.url()).hash).toBe("");
    const url = new URL(route.request().url());
    expect(url.searchParams.get("context")).toBe(registrationContext);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        rp: { id: "localhost", name: "Collab" },
        user: {
          id: base64url("foundation-owner"),
          name: "member_1",
          displayName: "Tim",
        },
        challenge: base64url("recovery-registration-challenge"),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        timeout: 60_000,
        attestation: "none",
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
      }),
    });
  });
  await page.route("**/api/auth/passkey/verify-registration", async (route) => {
    recoveryRegistrations += 1;
    expect(new URL(page.url()).hash).toBe("");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "passkey_2",
        name: "Mac Studio",
        userId: "member_1",
      }),
    });
  });
  await page.route("**/api/v1/auth/recovery/complete", async (route) => {
    recoveryCompletions += 1;
    expect(route.request().postDataJSON()).toEqual({ registrationContext });
    if (recoveryCompletions === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "TEMPORARY_FAILURE", message: "Try again." } }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: { memberId: "member_1", readyToSignIn: true },
      }),
    });
  });

  await page.goto(`/recover#${registrationContext}`);
  await expect(page).toHaveURL(/\/recover$/);
  await page.getByLabel("Passkey name").fill("Mac Studio");
  await page.getByRole("button", { name: "Register replacement passkey" }).click();
  await page.getByRole("button", { name: "Retry recovery completion" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(recoveryRegistrations).toBe(1);
  expect(recoveryCompletions).toBe(2);
});
