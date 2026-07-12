import { expect, test as base } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route("**/api/auth/get-session", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          session: {
            id: "session_e2e",
            userId: "member_e2e",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            token: "redacted",
          },
          user: {
            id: "member_e2e",
            name: "E2E Member",
            email: "member_e2e@identity.invalid",
            emailVerified: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      });
    });
    await use(page);
  },
});

export { expect };
