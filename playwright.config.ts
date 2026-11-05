import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the production build, the way users get it.
// DOCWALK_CHROMIUM_FULL_PATH points at a preinstalled full Chromium when one
// exists (fullscreen and pop-ups need the full browser, not the headless shell).
const executablePath = process.env.DOCWALK_CHROMIUM_FULL_PATH;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4174",
    viewport: { width: 1440, height: 900 },
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm preview --port 4174 --strictPort",
    url: "http://localhost:4174",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
