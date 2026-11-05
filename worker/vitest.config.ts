import { existsSync, readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Worker tests run inside workerd through Miniflare, with the real
// wrangler.jsonc bindings (decision 44). Run from the project root:
//   vitest run --config worker/vitest.config.ts
const project = `${import.meta.dirname}/..`;
const publicHeaders = `${project}/public/_headers`;

export default defineConfig({
  root: project,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: `${import.meta.dirname}/wrangler.jsonc` },
      // Wrangler loads worker/.dev.vars (or .env), where the README puts a
      // development GitHub App's credentials. Blank them, so tests see the
      // deployed config without secrets and a real secret never enters a test run.
      miniflare: { bindings: { GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" } },
    }),
  ],
  test: {
    include: ["worker/**/*.test.ts"],
    // workerd has no file system; headers.test.ts compares this file with headers.ts.
    provide: {
      publicHeaders: existsSync(publicHeaders) ? readFileSync(publicHeaders, "utf8") : null,
    },
  },
});
