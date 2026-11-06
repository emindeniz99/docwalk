import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * playwright.config.ts as it evaluates with or without the CI variable, for a
 * `playwright test` command line with the given arguments.
 */
async function loadConfig(ci: boolean, args: string[] = [], port?: string) {
  vi.resetModules();
  vi.stubEnv("CI", ci ? "true" : "");
  // A contributor whose port 4174 is busy exports DOCWALK_E2E_PORT; the
  // expectations below are for the default ports, so the shell's value must
  // not leak in and turn the unit stage red with no code change.
  vi.stubEnv("DOCWALK_E2E_PORT", port);
  process.argv = [argv[0] ?? "node", "playwright", "test", ...args];
  return (await import("../playwright.config.ts")).default;
}

const argv = [...process.argv];

afterEach(() => {
  vi.unstubAllEnvs();
  process.argv = [...argv];
});

/** The URL of every web server the config starts for a command line. */
async function servers(args: string[], port?: string) {
  const { webServer } = await loadConfig(true, args, port);
  return (Array.isArray(webServer) ? webServer : [webServer]).map((server) => server?.url);
}

describe("which servers an e2e run starts", () => {
  test("the Firefox and WebKit legs skip the sub-path build they never test", async () => {
    // Playwright has no per-project web servers and starts every entry. The
    // sub-path server is a second full production build (Mermaid, Monaco,
    // Excalidraw), so the firefox and webkit CI legs paid for one each and
    // read nothing from it.
    expect(await servers(["--project", "firefox"])).toEqual(["http://localhost:4174"]);
    expect(await servers(["--project=webkit"])).toEqual(["http://localhost:4174"]);
    expect(await servers(["e2e/i18n.spec.ts", "--project", "chromium"])).toHaveLength(1);
  });

  test("a run that includes static-subpath, or names no project, still gets its server", async () => {
    // Without the server the sub-path spec would fail on a refused connection.
    const both = ["http://localhost:4174", "http://localhost:4175/docwalk/"];
    expect(await servers([])).toEqual(both);
    expect(await servers(["--project", "chromium", "--project", "static-subpath"])).toEqual(both);
    // Playwright matches project names case-insensitively and with * wildcards.
    expect(await servers(["--project", "chromium", "Static-*"])).toEqual(both);
  });

  test("DOCWALK_E2E_PORT moves both servers, the sub-path one to the next port", async () => {
    // Two checkouts or agents run the suite side by side by giving each its
    // own port; a server left on 4175 would collide with the other run.
    expect(await servers([], "5000")).toEqual([
      "http://localhost:5000",
      "http://localhost:5001/docwalk/",
    ]);
  });
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
