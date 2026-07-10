import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  reporter: "list",
  testDir: "./tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun dist/server/index.js",
    env: {
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      PORT: "4173",
      SESSION_SECRET: "playwright-only-secret-0123456789",
    },
    reuseExistingServer: false,
    url: "http://127.0.0.1:4173/healthz",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
