import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { paraglideOptions } from "./tooling/paraglide.ts";
import { docwalkTokens } from "./tooling/tokens-plugin.ts";

// Layout and pagination tests must run in a real browser: jsdom has no layout
// engine, so every measurement there reads 0 (AGENTS.md rule 9).
const chromiumPath = process.env.DOCWALK_CHROMIUM_PATH;
const chromiumLaunch = chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {};

// Decision 42 runs the sanitizer corpus on all three engines, because an
// mXSS payload can depend on one engine's parser. The everyday browser
// project runs Chromium only; CI's Firefox and WebKit jobs, which install
// that engine anyway, set DOCWALK_SANITIZER_ENGINE and run this project.
const sanitizerEngine = process.env.DOCWALK_SANITIZER_ENGINE;
if (sanitizerEngine && !["chromium", "firefox", "webkit"].includes(sanitizerEngine)) {
  throw new Error(
    `DOCWALK_SANITIZER_ENGINE must be chromium, firefox or webkit, not ${sanitizerEngine}`,
  );
}
const sanitizerEngines = sanitizerEngine
  ? [
      {
        extends: true,
        // CI starts with no Vite cache: without these, Vite finds them in the
        // middle of the run, reloads, and the second test file never starts.
        optimizeDeps: {
          include: ["react", "react-dom/client", "react/jsx-dev-runtime", "react-aria-components"],
        },
        test: {
          name: "sanitizer-engines",
          include: ["src/render/sanitize.browser.test.ts", "src/deck/purify.browser.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(sanitizerEngine === "chromium" ? chromiumLaunch : {}),
            instances: [{ browser: sanitizerEngine as "chromium" | "firefox" | "webkit" }],
          },
        },
      },
    ]
  : [];

export default defineConfig({
  plugins: [docwalkTokens(), paraglideVitePlugin(paraglideOptions)],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "tooling/**/*.test.ts", "mcp/src/**/*.test.ts"],
          exclude: ["src/**/*.browser.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        // Shiki runs only in its worker, which Vite's dependency scanner does not follow. CI starts
        // with no Vite cache: without these, Vite finds them at the first code block, reloads,
        // and the test files still to start never do.
        optimizeDeps: {
          include: ["@shikijs/core", "@shikijs/engine-javascript", "@shikijs/primitive"],
        },
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(chromiumLaunch),
            instances: [{ browser: "chromium" }],
          },
        },
      },
      ...sanitizerEngines,
    ],
  },
});
