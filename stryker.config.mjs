// Mutation testing on the node-environment unit tests (decision 40), run
// nightly by .github/workflows/docwalk-mutation.yml. A surviving mutant is a
// change to the code that no unit test notices: either a missing assertion or
// dead code. Browser-only modules (.tsx, layout) are covered by Vitest Browser
// Mode and Playwright instead, so they are not mutated here.
// Run one module locally: pnpm mutation --mutate src/share/fragment.ts

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts" },
  plugins: ["@stryker-mutator/vitest-runner"],
  mutate: ["src/**/*.ts", "tooling/**/*.ts", "!**/*.test.ts", "!**/*.d.ts"],
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // Report only for now; set `break` once the nightly score has a baseline.
  thresholds: { high: 80, low: 60, break: null },
  // Stryker rewrites the tsconfig's out-of-sandbox paths through the
  // TypeScript JS API, which TypeScript 7 (the native compiler) no longer
  // ships. No docwalk tsconfig points outside the project, so there is nothing
  // to rewrite: name a file that does not exist and the step is skipped.
  tsconfigFile: "tsconfig.stryker-skip.json",
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
};
