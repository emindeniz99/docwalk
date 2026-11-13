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

const escapeRegExp = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether this `playwright test` command line runs the named project.
 * Playwright has no per-project web servers and starts every `webServer`
 * entry, so the sub-path build (a second full production build) is added only
 * when its project runs. A run that names no project runs them all. Matching
 * follows Playwright's: case-insensitive, `*` as a wildcard, and every
 * argument after `--project` up to the next flag is a project name.
 */
function runsProject(name: string): boolean {
  const args = process.argv;
  const selected: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--project=")) selected.push(arg.slice("--project=".length));
    if (arg !== "--project") continue;
    while (i + 1 < args.length && !args[i + 1]?.startsWith("-")) selected.push(args[++i] ?? "");
  }
  if (selected.length === 0) return true;
  return selected.some((pattern) =>
    new RegExp(`^${pattern.toLowerCase().split("*").map(escapeRegExp).join(".*")}$`).test(name),
  );
}

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  // GitHub's Linux runner has 4 cores; Playwright's CI default is half of
  // them. A third worker shortens the long WebKit leg on the same machine
  // (measured on branch ci/three-workers before it was adopted).
  workers: process.env.CI ? 3 : undefined,
  // A `test.only` left in after debugging would make every CI job run that
  // one test and pass; on CI it fails the run instead.
  forbidOnly: Boolean(process.env.CI),
  // CI uploads test-results/ and playwright-report/ when a job fails, so the
  // HTML report, traces and screenshots are what a failure is debugged from.
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // The production build registers a service worker. In WebKit, requests a
  // controlled page makes bypass Playwright's routing, so the specs that
  // stub the network would reach the real one. Only e2e/pwa.spec.ts, which
  // tests the worker itself, lets it run.
  use: {
    baseURL: `http://localhost:${port}`,
    viewport,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
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
    ...(runsProject("static-subpath")
      ? [
          {
            command: `pnpm exec vite build --base /docwalk/ --outDir dist-subpath && pnpm exec vite preview --base /docwalk/ --outDir dist-subpath --port ${subpathPort} --strictPort`,
            url: `http://localhost:${subpathPort}/docwalk/`,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
        ]
      : []),
  ],
});
