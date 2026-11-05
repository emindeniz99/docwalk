import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the production build, the way users get it,
// on all three engines (decision 39): reveal.js, Mermaid's SVG text measuring
// and the sanitizer each behave a little differently per engine.
//
// DOCWALK_CHROMIUM_FULL_PATH points at a preinstalled full Chromium when one
// exists (fullscreen and pop-ups need the full browser, not the headless shell).
// It applies to the Chromium projects only: handing a Chromium binary to the
// Firefox or WebKit launcher fails every test in those projects.
const executablePath = process.env.DOCWALK_CHROMIUM_FULL_PATH;
const chromiumLaunch = executablePath ? { launchOptions: { executablePath } } : {};
// Several agents or checkouts may run the suite at once; each picks a port.
// The sub-path build (GitHub Pages, decision 37) is served on the next one.
const port = Number(process.env.DOCWALK_E2E_PORT ?? 4174);
const subpathPort = port + 1;
const viewport = { width: 1440, height: 900 };
const SUBPATH_SPEC = "subpath.spec.ts";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${port}`, viewport },
  projects: [
    {
      name: "chromium",
      testIgnore: SUBPATH_SPEC,
      use: { ...devices["Desktop Chrome"], viewport, ...chromiumLaunch },
    },
    {
      name: "firefox",
      testIgnore: SUBPATH_SPEC,
      use: { ...devices["Desktop Firefox"], viewport },
    },
    {
      name: "webkit",
      testIgnore: SUBPATH_SPEC,
      use: { ...devices["Desktop Safari"], viewport },
    },
    {
      name: "static-subpath",
      testMatch: SUBPATH_SPEC,
      use: {
        ...devices["Desktop Chrome"],
        viewport,
        ...chromiumLaunch,
        baseURL: `http://localhost:${subpathPort}`,
      },
    },
  ],
  webServer: [
    {
      command: `pnpm build && pnpm preview --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `pnpm exec vite build --base /docwalk/ --outDir dist-subpath && pnpm exec vite preview --base /docwalk/ --outDir dist-subpath --port ${subpathPort} --strictPort`,
      url: `http://localhost:${subpathPort}/docwalk/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
