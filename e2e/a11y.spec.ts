import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ready } from "./helpers";

/**
 * axe-core against every surface people use (decision 41, WCAG 2.2 AA).
 * Component tests cover each widget's roles; only the assembled pages show
 * contrast on the real backgrounds, landmark and heading structure, names
 * that survive icon-only layouts, and what an open dialog hides.
 */

const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(serious).toEqual([]);
}

/** A Worker that offers remote control, with a room socket that simply stays open. */
async function fakeRemoteWorker(context: BrowserContext) {
  await context.route("**/api/health", (route) =>
    route.fulfill({ json: { ok: true, features: ["remote"] } }),
  );
  await context.routeWebSocket(/\/api\/remote\//, () => {});
}

test("edit view", async ({ page }) => {
  // The workbench: header, outline, editor and stage, where an author spends most of the time.
  await ready(page);
  await expectNoSeriousViolations(page);
});

test("document view", async ({ page }) => {
  // Rendered Markdown from untrusted documents: wide tables and diagrams must stay reachable.
  await ready(page);
  await page.getByRole("radio", { name: "Document" }).click();
  await expect(page.locator(".docwalk-document")).toBeVisible();
  await expectNoSeriousViolations(page);
});

test("present view", async ({ page }) => {
  // What the room sees; reveal.js adds its own controls, which must pass too.
  await ready(page);
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  await expectNoSeriousViolations(page);
});

test("present view with the controls hidden", async ({ page }) => {
  // Idle, the bar and tools fade out but stay in the page (decision 75): they
  // must still have names and roles, and nothing invisible may be left half-drawn.
  await ready(page);
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-chrome", "hidden", {
    timeout: 10_000,
  });
  await expect(page.locator(".docwalk-preview-head")).toHaveCSS("opacity", "0");
  await expectNoSeriousViolations(page);
});

test("open command palette", async ({ page }) => {
  // The keyboard route to every command; a modal must hide the page behind it.
  await ready(page);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await expectNoSeriousViolations(page);
});

test("open share dialog", async ({ page }) => {
  // The only way a pasted document leaves the browser.
  await ready(page);
  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByRole("dialog").getByLabel("Link")).toBeVisible();
  await expectNoSeriousViolations(page);
});

test("open token dialog", async ({ page }) => {
  // A password-type field and external links in a modal reached from the overflow menu.
  await ready(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "GitHub token…" }).click();
  await expect(page.getByRole("dialog", { name: "GitHub access token" })).toBeVisible();
  await expectNoSeriousViolations(page);
});

test("open join dialog", async ({ page, context }) => {
  // QR codes and copy fields: images need names and the status must be announced.
  await fakeRemoteWorker(context);
  await ready(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Remote and followers…" }).click();
  await expect(
    page.getByRole("dialog", { name: "Remote control" }).getByText("Room open"),
  ).toBeVisible();
  await expectNoSeriousViolations(page);
});

test("presenter window", async ({ page, context }) => {
  // A separate page with its own landmarks, timer and controls.
  // The fixture is rendered twice, as the audience deck and again as the
  // presenter's previews (decision 8), on top of a second page load and the
  // audit. On WebKit with two busy cores that took 19-22 s (20-26 s before
  // the previews were built slide by slide); the CI runner has been about
  // twice as slow, which leaves the default 60 s too tight for this one test.
  test.setTimeout(90_000);
  await ready(page);
  const popup = context.waitForEvent("page");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popup;
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  // "Now" shows as soon as the deck's state arrives; the previews come from
  // the whole slide pipeline afterwards. Audit the page they make, not one
  // still being built while the audit competes with it for the main thread.
  await expect(presenter.getByRole("status")).toBeEmpty({ timeout: 60_000 });
  await expectNoSeriousViolations(presenter);
});

test("phone remote", async ({ page, context }) => {
  // A phone in a dark room: contrast and 44 px targets matter most here.
  await fakeRemoteWorker(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?view=remote#room=${"r".repeat(22)}&k=${"k".repeat(43)}`);
  await expect(page.getByRole("status").getByText("Connected")).toBeVisible();
  await expectNoSeriousViolations(page);
});
