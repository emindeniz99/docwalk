import { afterEach, describe, expect, test, vi } from "vitest";

/** playwright.config.ts as it evaluates with or without the CI variable. */
async function loadConfig(ci: boolean) {
  vi.resetModules();
  vi.stubEnv("CI", ci ? "true" : "");
  return (await import("../playwright.config.ts")).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Playwright on CI", () => {
  test("a committed test.only fails the run instead of skipping the rest of the suite", async () => {
    // Without forbidOnly, one focused test left in after debugging makes every
    // e2e job run that test alone and report success. Vitest refuses `.only`
    // on CI by itself; Playwright does not, and oxlint does not flag it.
    expect((await loadConfig(true)).forbidOnly).toBe(true);
    // Locally `.only` is how you debug one spec.
    expect((await loadConfig(false)).forbidOnly).toBe(false);
  });

  test("a failed test leaves a trace, a screenshot and an HTML report for the uploaded artifact", async () => {
    // The CI job uploads test-results/ and playwright-report/ when e2e fails.
    // A Firefox- or WebKit-only failure is often impossible to reproduce on
    // the author's machine, so the artifact has to hold enough to debug from.
    const config = await loadConfig(true);
    expect(config.use?.trace).toBe("retain-on-failure");
    expect(config.use?.screenshot).toBe("only-on-failure");
    const reporters = Array.isArray(config.reporter) ? config.reporter : [[config.reporter]];
    const names = reporters.map((reporter) => (Array.isArray(reporter) ? reporter[0] : reporter));
    expect(names).toEqual(expect.arrayContaining(["github", "html"]));
    const html = reporters.find((reporter) => Array.isArray(reporter) && reporter[0] === "html");
    // The runner has no one to open a browser for.
    expect(html?.[1]).toMatchObject({ open: "never" });
  });
});
