import { expect, test } from "@playwright/test";

const base64url = (value: string) => Buffer.from(value).toString("base64url");

test("empty deployment bootstrap registers the owner passkey without exposing session proof", async ({
  context,
  page,
}) => {
  const cdp = await context.newCDPSession(page);
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

  await page.route("**/api/v1/auth/passkeys/registration/begin", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body).toMatchObject({ displayName: "Tim", bootstrapSecret: "b".repeat(32) });
    expect(body).not.toHaveProperty("principal");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: {
          challengeId: "challenge_1",
          options: {
            rp: { id: "localhost", name: "Collab" },
            user: {
              id: base64url("foundation-owner"),
              name: "owner",
              displayName: "Tim",
            },
            challenge: base64url("foundation-registration-challenge"),
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            timeout: 60_000,
            attestation: "none",
            authenticatorSelection: {
              residentKey: "required",
              userVerification: "required",
            },
          },
        },
      }),
    });
  });
  await page.route("**/api/v1/bootstrap", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(body).toMatchObject({
      displayName: "Tim",
      credentialName: "Tim's Mac",
      challengeId: "challenge_1",
    });
    expect(body.response).toBeDefined();
    await route.fulfill({
      contentType: "application/json",
      headers: {
        "set-cookie": "collab_session=session_1.private-proof; Path=/; HttpOnly; SameSite=Strict",
      },
      body: JSON.stringify({
        ok: true,
        value: { memberId: "member_1", expiresAt: 900, csrfProof: "c".repeat(32) },
      }),
    });
  });

  await page.goto("/setup");
  await page.getByLabel("Bootstrap secret").fill("b".repeat(32));
  await page.getByLabel("Your name").fill("Tim");
  await page.getByLabel("Passkey name").fill("Tim's Mac");
  await page.getByRole("button", { name: "Register passkey" }).click();

  await expect(page.getByRole("heading", { name: "Your team is ready" })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("collab_csrf"))).toBe("c".repeat(32));
  expect(await page.textContent("body")).not.toContain("private-proof");
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
          "collab_invitation=exchange-session-secret; Path=/join; HttpOnly; SameSite=Strict",
      },
      body: JSON.stringify({
        ok: true,
        value: { invitationId: "invite_1", expiresAt: 900 },
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
  expect(invitationCookie).toMatchObject({ httpOnly: true, path: "/join", sameSite: "Strict" });
});

test("signed-in owner approves the exact CLI device authorization", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("collab_csrf", "c".repeat(32)));
  await page.route("**/api/v1/device/authorization/device_code_1/approve", async (route) => {
    expect(route.request().headers()["x-collab-csrf"]).toBe("c".repeat(32));
    expect(route.request().postDataJSON()).toMatchObject({ idempotencyKey: expect.any(String) });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: { deviceCodeId: "device_code_1", state: "APPROVED", revision: 2 },
      }),
    });
  });

  await page.goto("/device/authorize/device_code_1");
  await expect(page.getByRole("heading", { name: "Authorize this CLI device?" })).toBeVisible();
  await page.getByRole("button", { name: "Authorize device" }).click();
  await expect(page.getByText("CLI device authorized")).toBeVisible();
});
