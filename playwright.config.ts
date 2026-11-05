import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the production build, the way users get it,
// on all three engines (decision 39): reveal.js, Mermaid's SVG text measuring
// and the sanitizer each behave a little differently per engine.
//
// DOCWALK_CHROMIUM_FULL_PATH points at a preinstalled full Chromium when one
// exists (fullscreen and pop-ups need the full browser, not the headless shell).
// It applies to the chromium project only: handing a Chromium binary to the
// Firefox or WebKit launcher fails every test in those projects.
const executablePath = process.env.DOCWALK_CHROMIUM_FULL_PATH;
// Several agents or checkouts may run the suite at once; each picks a port.
const port = Number(process.env.DOCWALK_E2E_PORT ?? 4174);
const baseURL = `http://localhost:${port}`;
const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, viewport },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport,
        ...(executablePath ? { launchOptions: { executablePath } } : {}),
      },
    },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport } },
  ],
  webServer: {
    command: `pnpm build && pnpm preview --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
