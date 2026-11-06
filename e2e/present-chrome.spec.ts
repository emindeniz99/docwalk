import { expect, test, type Locator, type Page } from "@playwright/test";
import { ready } from "./helpers";

/**
 * Presenting chrome that steps aside (decision 75). On a phone in landscape
 * the bar above the slide and the annotation tools took a third of the
 * screen, and iPhone Safari has no Fullscreen API for pages. These tests
 * guard the trade: the slide gets the stage while nobody touches anything,
 * and nobody (mouse, touch, keyboard, screen reader) loses the controls.
 */

/** Longer than the 3 s idle delay plus the fade, with room for a slow CI engine. */
const HIDE_TIMEOUT = 10_000;

const app = (page: Page) => page.locator(".docwalk-app");
const bar = (page: Page) => page.locator(".docwalk-preview-head");
const slide = (page: Page) => page.locator(".reveal .slides > section.present");

async function present(page: Page) {
  await ready(page);
  await page.getByRole("button", { name: "Present" }).click();
  await expect(app(page)).toHaveAttribute("data-view", "present");
}

async function waitHidden(page: Page) {
  await expect(app(page)).toHaveAttribute("data-chrome", "hidden", { timeout: HIDE_TIMEOUT });
}

async function width(locator: Locator): Promise<number> {
  return (await locator.boundingBox())?.width ?? 0;
}

/** A point on the stage beside the slide: not on the slide, not on the bar. */
async function besideSlide(page: Page) {
  const box = await slide(page).boundingBox();
  if (!box) throw new Error("no slide");
  return { x: box.x / 2, y: box.y + box.height / 2 };
}

test.describe("phone in landscape", () => {
  // A phone on its side, where the bar costs height the slide needs. On a
  // wide desktop window the slide is bound by width and has nothing to gain.
  test.use({ viewport: { width: 844, height: 390 } });

  test("idle, the chrome hides and the slide grows into the stage; a mouse move brings both back", async ({
    page,
  }) => {
    await present(page);
    await expect(bar(page)).toHaveCSS("opacity", "1");
    const withChrome = await width(slide(page));

    await waitHidden(page);
    // Hidden for the eye and the pointer, but still in the page for assistive technology.
    await expect(bar(page)).toHaveCSS("opacity", "0");
    await expect(bar(page)).toHaveCSS("pointer-events", "none");
    await expect(page.getByRole("button", { name: "Slide overview" })).toBeAttached();
    // The point of hiding: reveal.js re-scales the slide into the freed space.
    await expect.poll(() => width(slide(page))).toBeGreaterThan(withChrome * 1.05);

    await page.mouse.move(200, 200);
    await page.mouse.move(260, 240);
    await expect(app(page)).not.toHaveAttribute("data-chrome", "hidden");
    await expect(bar(page)).toHaveCSS("opacity", "1");
    await expect.poll(() => width(slide(page))).toBeLessThan(withChrome * 1.05);
  });
});

test("the first hide says how to get the controls back, and only the first", async ({ page }) => {
  await present(page);
  await waitHidden(page);
  const hint = page.getByRole("status").filter({ hasText: "Tap or move to show controls" });
  await expect(hint).toBeVisible();

  // A presenter who has seen it once does not need it on every slide or talk.
  await page.reload();
  await present(page);
  await waitHidden(page);
  await expect(page.locator(".docwalk-chrome-hint")).toBeEmpty();
});

test("ArrowRight while hidden moves the deck and leaves the slide big", async ({ page }) => {
  await present(page);
  await waitHidden(page);
  const address = page.locator(".docwalk-preview-address");
  const before = await address.textContent();

  // A clicker sends arrow and page keys; each one must not bring the bar back over the slide.
  await page.keyboard.press("ArrowRight");
  await expect(address).not.toHaveText(before ?? "");
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(300);
  await expect(app(page)).toHaveAttribute("data-chrome", "hidden");
});

test("Tab while hidden shows the controls and focuses the first; focus keeps them up", async ({
  page,
}) => {
  await present(page);
  await waitHidden(page);

  // The bar comes before the deck in the DOM: without this, Tab from the
  // slide would leave the page and a keyboard user would find nothing.
  await page.keyboard.press("Tab");
  await expect(app(page)).not.toHaveAttribute("data-chrome", "hidden");
  await expect(page.getByRole("button", { name: "Slide overview" })).toBeFocused();

  // A control with keyboard focus must not vanish from under it.
  await page.waitForTimeout(4_000);
  await expect(app(page)).not.toHaveAttribute("data-chrome", "hidden");

  // Back on the slide, it hides again, and Shift+Tab lands on the last control.
  await page.locator(".reveal").focus();
  await waitHidden(page);
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Clear marks" })).toBeFocused();
});

test.describe("touch", () => {
  test.use({ hasTouch: true });

  test("a tap with the pen draws and leaves the chrome alone; the stage beside the slide toggles it", async ({
    page,
  }) => {
    await present(page);
    await page.getByRole("radio", { name: "Pen" }).tap();
    await waitHidden(page);

    // The slide belongs to the tool: a tap there is ink, not a request for the bar.
    const box = await slide(page).boundingBox();
    if (!box) throw new Error("no slide");
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('.docwalk-annotate-draw[data-active="true"] path')).not.toHaveCount(
      0,
    );
    await page.waitForTimeout(300);
    await expect(app(page)).toHaveAttribute("data-chrome", "hidden");

    // The stage around the slide is always the way back, whatever the tool.
    const beside = await besideSlide(page);
    await page.touchscreen.tap(beside.x, beside.y);
    await expect(app(page)).not.toHaveAttribute("data-chrome", "hidden");
    await page.touchscreen.tap(beside.x, beside.y);
    await expect(app(page)).toHaveAttribute("data-chrome", "hidden");
  });

  test("without a tool, a tap on the slide shows the chrome", async ({ page }) => {
    await present(page);
    await waitHidden(page);
    const box = await slide(page).boundingBox();
    if (!box) throw new Error("no slide");
    // Below the title, on plain slide background: nothing there wants the tap.
    await page.touchscreen.tap(box.x + box.width * 0.75, box.y + box.height * 0.85);
    await expect(app(page)).not.toHaveAttribute("data-chrome", "hidden");
  });
});

test("with a drawing tool, a mouse over the slide keeps the slide big; the stage edge shows the bar", async ({
  page,
}) => {
  await present(page);
  await page.keyboard.press("l");
  await waitHidden(page);
  const box = await slide(page).boundingBox();
  if (!box) throw new Error("no slide");
  // Pointing with the laser must not make the slide shrink under the pointer.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 4 });
  await page.waitForTimeout(300);
  await expect(app(page)).toHaveAttribute("data-chrome", "hidden");

  const beside = await besideSlide(page);
  await page.mouse.move(beside.x, beside.y, { steps: 4 });
  await expect(app(page)).not.toHaveAttribute("data-chrome", "hidden");
});

test("Always show presenting controls keeps the bar, and the choice is remembered", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "More actions" }).click();
  const item = page.getByRole("menuitemcheckbox", { name: "Always show presenting controls" });
  await expect(item).toHaveAttribute("aria-checked", "false");
  await item.click();

  // For presenters who would rather see the counter and tools all the time.
  await page.reload();
  await present(page);
  await page.waitForTimeout(4_500);
  await expect(app(page)).not.toHaveAttribute("data-chrome", "hidden");
  await expect(bar(page)).toHaveCSS("opacity", "1");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(item).toHaveAttribute("aria-checked", "true");
});

test("a viewer who asked for less motion gets the chrome without a fade", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await present(page);
  const duration = await bar(page).evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(Number.parseFloat(duration)).toBeLessThan(0.01);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  const fade = await bar(page).evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(fade.split(",").map(Number.parseFloat)).toContain(0.2);
});
