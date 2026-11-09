import { readFileSync } from "node:fs";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

/**
 * The focus view for code, tables and images (decision 87) in the built app.
 * The component tests cover the behaviour; these cover what only the whole
 * page shows: the network, the app's own shortcuts, axe on the real
 * backgrounds, and a phone-sized window.
 */

const SHOTS = process.env["DOCWALK_SHOTS"];
const REMOTE = "https://images.invalid/chart.png";
// The app's own icon, so the stubbed image has a real size on the slide.
const PNG = readFileSync(new URL("../public/icons/icon-192.png", import.meta.url));

const CODE = [
  "## Code",
  "",
  "```ts",
  "export function retry(attempt: number): number {",
  "  const base = 200;",
  "",
  "  return base * 2 ** attempt;",
  "}",
  "```",
  "",
].join("\n");
const TABLE = [
  "## Table",
  "",
  "| Region | Writes per second | p50 latency | p99 latency | Error budget | Owner |",
  "| --- | --- | --- | --- | --- | --- |",
  "| eu-west | 5,200 | 12 ms | 80 ms | 0.1% | storage |",
  "| us-east | 7,900 | 15 ms | 91 ms | 0.1% | storage |",
  "",
].join("\n");
const IMAGE = "## Image\n\n![Company logo](/icons/icon-192.png)\n";

const present = (page: Page) => page.locator(".reveal .slides > section.present");
const view = (page: Page) => page.locator(".docwalk-focus");

async function openDoc(page: Page, markdown: string, slides = 1) {
  await ready(page);
  await replaceSource(page, markdown);
  await expect(page.locator(".docwalk-statusbar")).toContainText(
    new RegExp(`(?<!\\d)${slides} slides?`),
  );
}

async function startPresenting(page: Page) {
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test("a remote image opens only after the viewer loaded it, and the view asks the network for nothing", async ({
  page,
}) => {
  // Decision 33 is the gate. The focus view is not a second way past it: a
  // blocked image stays a placeholder, a loaded one opens from the copy the
  // slide holds, even when the host forbids caching.
  const requests: string[] = [];
  await page.route(REMOTE, (route) => {
    requests.push(route.request().url());
    return route.fulfill({
      body: PNG,
      contentType: "image/png",
      headers: { "Cache-Control": "no-store" },
    });
  });
  await openDoc(page, `## Chart\n\n![Chart](${REMOTE})\n`);
  const img = present(page).locator("img");
  await expect(img).toHaveClass(/docwalk-blocked-image/);
  expect(requests).toEqual([]);

  // The first activation only loads; it does not open the view as well.
  await img.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  await expect(img).not.toHaveClass(/docwalk-blocked-image/);
  await expect(view(page)).toHaveCount(0);

  // Loaded now, it is a focus target and opens from the copy it already holds.
  await expect(img).toHaveAttribute("data-docwalk-focus", "image");
  await img.click();
  await expect(view(page)).toBeVisible();
  await expect(view(page).locator("img")).toHaveJSProperty("complete", true);
  await page.waitForTimeout(300);
  expect(requests).toHaveLength(1);
});

test("a blocked image that was never loaded cannot be opened, and nothing is requested", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("https://images.invalid/**", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await openDoc(page, `## Chart\n\n![Chart](${REMOTE})\n`);
  const frame = present(page).locator(".docwalk-blocked-frame");
  await expect(frame).toBeVisible();
  await expect(present(page).locator("[data-docwalk-focus]")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(view(page)).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("while a view is open, O, the pen letters and the arrows stay out of the app and Escape closes only the view", async ({
  page,
}) => {
  await openDoc(
    page,
    `${CODE}
## Two

Second.

## Three

Last.
`,
    3,
  );
  // The editor opens the slide under the cursor, which is the last one; start on the code.
  await page.evaluate(() => {
    window.location.hash = "#code";
  });
  await startPresenting(page);
  const address = () => present(page).getAttribute("data-docwalk-id");
  const slide = await address();
  await present(page).locator("pre").click();
  await expect(view(page)).toBeVisible();

  await page.keyboard.press("o");
  await page.keyboard.press("p");
  await page.keyboard.press("l");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("PageDown");
  // No overview dialog, no pen: the only dialog is the focus view, on the same slide.
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(view(page)).toBeVisible();
  expect(await address()).toBe(slide);
  await expect(page.locator(".docwalk-annotate-button[data-selected]")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);
  // The first Escape closed the view and no more: the talk goes on.
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  await expect(present(page).locator("pre")).toBeFocused();
  // Arrows steer the deck again.
  await page.keyboard.press("ArrowRight");
  await expect.poll(address).not.toBe(slide);
});

test("marked code lines stay marked while the view is open and are gone after it closes", async ({
  page,
}) => {
  await openDoc(page, CODE);
  await startPresenting(page);
  await present(page).locator("pre").click();
  const lines = view(page).locator(".docwalk-code-line");
  await expect(lines).toHaveCount(5);
  await lines.nth(0).click();
  await lines.nth(3).click();
  await expect(view(page).locator('.docwalk-code-line[aria-pressed="true"]')).toHaveCount(2);
  await shot(page, "code-marked-desktop");
  await view(page).getByRole("button", { name: "Clear all marked lines" }).click();
  await expect(view(page).locator('.docwalk-code-line[aria-pressed="true"]')).toHaveCount(0);
  // Clear disables itself; focus moved into the view first, so Escape still closes it.
  await page.keyboard.press("Escape");
  await expect(view(page)).toHaveCount(0);
  await present(page).locator("pre").click();
  await lines.nth(1).click();
  await page.keyboard.press("Escape");
  await present(page).locator("pre").click();
  await expect(view(page).locator('.docwalk-code-line[aria-pressed="true"]')).toHaveCount(0);
});

for (const [name, markdown, selector] of [
  ["code", CODE, "pre"],
  ["table", TABLE, "table"],
  ["image", IMAGE, "img"],
] as const) {
  test(`the ${name} view passes axe with the page behind it inert`, async ({ page }) => {
    await openDoc(page, markdown);
    await startPresenting(page);
    await expect(present(page).locator(selector)).toBeVisible();
    await present(page).locator(selector).click();
    await expect(view(page)).toBeVisible();
    if (name === "code") await view(page).locator(".docwalk-code-line").nth(2).click();
    // Jump running transitions to their end so axe reads settled colours.
    // Never await `finished` here: entering present mode fades the reveal.js
    // arrows, and WebKit cancels and restarts their pseudo-elements' colour
    // transitions every frame of that fade. A cancelled transition's
    // `finished` rejects with AbortError. Finishing one fade can start
    // another, so repeat until none run, and fail loud if they never stop.
    const left = await page.evaluate(() => {
      for (let pass = 0; pass <= 10; pass++) {
        const running = document
          .getAnimations()
          .filter((a): a is CSSTransition => a instanceof CSSTransition);
        if (running.length === 0 || pass === 10) return running.map((a) => a.transitionProperty);
        for (const a of running) a.finish();
      }
      return [];
    });
    expect(left, "transitions still running after ten passes").toEqual([]);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const serious = results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
    expect(serious).toEqual([]);
    await shot(page, `${name}-desktop`);
  });

  test(`the ${name} view fits a phone and its controls stay on screen`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openDoc(page, markdown);
    await startPresenting(page);
    // The slide is a third of its size here; the view is the way to read it.
    await present(page).locator(selector).click();
    await expect(view(page)).toBeVisible();
    const sizes = await page.evaluate(() => {
      const toolbar = document.querySelector(".docwalk-focus-toolbar")!;
      return {
        page: document.documentElement.scrollWidth,
        window: innerWidth,
        buttons: [...toolbar.querySelectorAll("button")].map((b) => {
          const { left, right, bottom, height } = b.getBoundingClientRect();
          return { left, right, bottom, height };
        }),
        height: innerHeight,
      };
    });
    expect(sizes.page).toBeLessThanOrEqual(sizes.window);
    for (const b of sizes.buttons) {
      expect(b.left).toBeGreaterThanOrEqual(0);
      expect(b.right).toBeLessThanOrEqual(sizes.window);
      expect(b.bottom).toBeLessThanOrEqual(sizes.height);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    // Text starts at the inline start edge: nothing is hidden to the left of where scrolling begins.
    const start = await view(page)
      .locator(".docwalk-focus-stage")
      .evaluate((stage) => {
        const first = stage.querySelector("th, .docwalk-code-line, img");
        return {
          scrolled: stage.scrollLeft,
          gap: first ? first.getBoundingClientRect().left - stage.getBoundingClientRect().left : 0,
        };
      });
    expect(start.scrolled).toBe(0);
    expect(start.gap).toBeGreaterThanOrEqual(0);
    await shot(page, `${name}-phone`);
  });
}
