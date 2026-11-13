import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

// Mutation testing runs only the node-environment unit project (decision 40):
// Stryker's Vitest runner has no project filter, and the browser project
// would start Chromium for every mutant. The unit project is taken from the
// main config so the two never disagree about which files are unit tests.
const unit = base.test?.projects?.find(
  (project) => typeof project === "object" && "test" in project && project.test?.name === "unit",
);
if (!unit || typeof unit !== "object" || !("test" in unit)) {
  throw new Error('vitest.config.ts has no "unit" project for mutation testing');
}

// Stryker's perTest coverage counts every statement each test runs, which
// makes the 2 MB search tests in src/shell/slideSearch.test.ts (decisions
// 116 and 123) about twelve times slower: 0.5-0.8 s under `pnpm check`,
// 6.2-9.9 s in a local dry run, past Vitest's 5 s default (measured
// 2026-11-13). The nightly runner reached the timeout about 1.4 times later
// than a local run. 30 s leaves room for a slower runner; Stryker's own
// timeout still catches a mutant that hangs, and `pnpm check` keeps 5 s.
const instrumentedTestTimeout = 30_000;

export default defineConfig({
  plugins: base.plugins ?? [],
  test: { ...unit.test, name: "mutation", testTimeout: instrumentedTestTimeout },
});
