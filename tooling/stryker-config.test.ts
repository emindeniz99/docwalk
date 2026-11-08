import { existsSync, globSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { describe, expect, test } from "vitest";
import config from "../stryker.config.mjs";

/**
 * The files the nightly mutation run (decision 40) mutates. Its tests are the
 * node-environment unit project only, so a mutant in a module that only a
 * `*.browser.test.ts` exercises can never be killed: Stryker reports it as
 * NoCoverage, which lowers the score and buries the survivors worth fixing.
 */
const root = join(import.meta.dirname, "..");
// The config is plain JavaScript, so its type does not reach this file.
const patterns: string[] = config.mutate ?? [];
const include = patterns.filter((pattern) => !pattern.startsWith("!"));
const exclude = patterns.filter((pattern) => pattern.startsWith("!")).map((p) => p.slice(1));
const mutated = include
  // globSync returns backslashes on Windows; the assertions below name "/" paths.
  .flatMap((pattern) => globSync(pattern, { cwd: root }).map((file) => file.replaceAll("\\", "/")))
  .filter((file) => !exclude.some((pattern) => matchesGlob(file, pattern)));

const exists = (file: string) => existsSync(join(root, file));

describe("what Stryker mutates", () => {
  test("no module whose only test runs in the browser", () => {
    const browserOnly = mutated.filter(
      (file) =>
        exists(file.replace(/\.ts$/, ".browser.test.ts")) &&
        !exists(file.replace(/\.ts$/, ".test.ts")),
    );
    expect(browserOnly).toEqual([]);
    // Pagination is the clearest case: it measures the DOM, so only Chromium tests it.
    expect(mutated).not.toContain("src/deck/paginate.ts");
  });

  test("the node-tested code, the MCP server's included", () => {
    // These have unit tests the mutation run executes; leaving them out
    // would make the report silent about code it can judge.
    expect(mutated).toContain("src/share/fragment.ts");
    expect(mutated).toContain("tooling/csp-plugin.ts");
    expect(mutated).toContain("mcp/src/room.ts");
    expect(mutated).toContain("mcp/src/server.ts");
    expect(mutated.filter((file) => file.endsWith(".test.ts"))).toEqual([]);
  });
});
