import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Layout and pagination tests must run in a real browser: jsdom has no layout
// engine, so every measurement there reads 0 (AGENTS.md rule 9).
const chromiumPath = process.env.DOCWALK_CHROMIUM_PATH;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.browser.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(
              chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {},
            ),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
