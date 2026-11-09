import { expect, test, type BrowserContext } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

/**
 * GitHub Pages serves a project site from `/<repo>/`, not from the domain
 * root (decision 37). A build that still points one chunk, font or
 * stylesheet at `/assets/...` works at the root, where every other test
 * runs, and breaks only there. The `static-subpath` project serves
 * `vite build --base /docwalk/` (see playwright.config.ts) for this file.
 */

const BASE = "/docwalk/";

/** Same-origin requests any page made outside the base path, or that failed. */
function strayRequests(context: BrowserContext, origin: string) {
  const stray: string[] = [];
  context.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== origin) return;
    // Static mode feature-detects the Worker at the origin's /api/health and
    // hides OAuth and remote control on its 404 (AGENTS rule 6).
    if (url.pathname === "/api/health") return;
    if (!url.pathname.startsWith(BASE) || response.status() >= 400) {
      stray.push(`${response.status()} ${url.pathname}`);
    }
  });
  return stray;
}

const origin = () => new URL(test.info().project.use.baseURL ?? "").origin;

test("the editor, deck, diagrams and fonts load from the sub-path", async ({ page, context }) => {
  const stray = strayRequests(context, origin());
  await ready(page, BASE);
  // The sample's Mermaid diagrams come from a lazy chunk.
  await expect
    .poll(() => page.locator("svg[id^='docwalk-mermaid-']").count(), { timeout: 30_000 })
    .toBeGreaterThan(0);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family);
  });
  expect(fonts.join(" ")).toMatch(/Inter/);
  expect(stray).toEqual([]);
});

test("a formula draws from the sub-path", async ({ page, context }) => {
  // The math worker's script is its own file: its URL must carry the base too.
  const stray = strayRequests(context, origin());
  await ready(page, BASE);
  await replaceSource(page, "# Math\n\n## Formula\n\nSquare: $x^2$ here.\n");
  await expect(page.locator(".reveal .slides p > math")).toHaveCount(1, { timeout: 30_000 });
  const worker = page.workers().find((w) => /math\.worker-/.test(w.url()));
  expect(new URL(worker?.url() ?? "http://none/").pathname.startsWith(BASE)).toBe(true);
  expect(stray).toEqual([]);
});

test("document view and the presenter window load from the sub-path", async ({ page, context }) => {
  const stray = strayRequests(context, origin());
  await page.goto(`${BASE}?view=document`);
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "document");

  // The presenter window is a separate lazy entry opened at the current URL.
  const popup = context.waitForEvent("page");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popup;
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(new URL(presenter.url()).pathname).toBe(BASE);
  expect(stray).toEqual([]);
});
