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

export default defineConfig({
  plugins: base.plugins ?? [],
  test: { ...unit.test, name: "mutation" },
});
