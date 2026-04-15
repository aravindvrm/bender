import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PLAYWRIGHT_SERVER_PORT ?? "4173");
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const headed = process.env.PW_HEADED === "1" || process.env.PW_HEADED === "true";

export default defineConfig({
  testDir: "./tests/e2e-playwright",
  testMatch: "**/*.spec.ts",
  testIgnore: ["**/._*"],
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    headless: !headed,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "node tests/playwright-server.mjs",
    url: `${BASE_URL}/api/project`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      PLAYWRIGHT_SERVER_PORT: String(PORT),
    },
  },
});
