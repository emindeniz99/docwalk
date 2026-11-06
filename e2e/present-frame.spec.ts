import { expect, test, type Page } from "@playwright/test";
import { ready } from "./helpers";

/**
 * The present frame (decision 77). The card frame left a dark stage around
 * the slide on every side, a third of the screen at 1366x768 even in
 * fullscreen. The fill frame, the default, gives the slide the screen up to
 * its fixed 16:9 fit, paints whatever is left in the slide's own colour, and
 * lays the controls over the slide so they cost no room. These tests guard
 * the room's view (size, colour), the slide's addresses (pagination must not
 * follow the frame: followers and links address `<section-id>/<n>`), and the
 * card frame for those who keep it.
 */

const HIDE_TIMEOUT = 10_000;
const CARD_KEY = "docwalk.presentCardFrame";

const app = (page: Page) => page.locator(".docwalk-app");
const bar = (page: Page) => page.locator(".docwalk-preview-head");
const slide = (page: Page) => page.locator(".reveal .slides > section.present");
const card = (page: Page) => slide(page).locator(".docwalk-slide");

async function present(page: Page) {
  await page.getByRole("button", { name: "Present" }).click();
  await expect(app(page)).toHaveAttribute("data-view", "present");
}

async function useCardFrame(page: Page) {
  await page.addInitScript((key) => localStorage.setItem(key, "true"), CARD_KEY);
}

async function box(page: Page) {
  const b = await slide(page).boundingBox();
  if (!b) throw new Error("no slide");
  return b;
}

/**
 * How far the slide falls short of the largest 16:9 box the window holds, as
 * a fraction (0 = edge to edge), and how far off centre it sits. Measured
 * against the window, not the emulated viewport: headless Firefox puts a
 * fullscreen page on its own 1366 px screen.
 */
async function fillGap(page: Page) {
  const b = await box(page);
  const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const scale = Math.min(w / 1280, h / 720);
  return {
    short: Math.max(1 - b.width / (1280 * scale), 1 - b.height / (720 * scale)),
    overhang: Math.max(b.width - w, b.height - h),
    offCentre: Math.abs(b.x + b.width / 2 - w / 2) + Math.abs(b.y + b.height / 2 - h / 2),
  };
}

/**
 * Gives the deck keyboard focus the way a keyboard user does. Present's
 * click focuses it, and Firefox keeps that focus invisible through later key
 * presses, so leave it with Tab and come back with Shift+Tab.
 */
async function keyboardFocusDeck(page: Page) {
  const reveal = page.locator(".reveal");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(reveal).toBeFocused();
  await expect.poll(() => reveal.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
}

/** The pages the deck built, by address, in order. */
const addresses = (page: Page) =>
  page
    .locator(".reveal .slides > section")
    .evaluateAll((els) =>
      els.map(
        (el) =>
          `${(el as HTMLElement).dataset["docwalkId"]}/${(el as HTMLElement).dataset["page"] ?? "1"}`,
      ),
    );

const background = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);

for (const [name, viewport] of [
  ["a 16:10 laptop", { width: 1440, height: 900 }],
  ["a phone in landscape", { width: 844, height: 390 }],
] as const) {
  test.describe(`fill frame on ${name}`, () => {
    test.use({ viewport });

    test("the slide takes the screen up to its 16:9 fit, and showing the controls does not shrink it", async ({
      page,
    }) => {
      await ready(page);
      await present(page);
      // reveal.js steps its scale by 0.01, so the slide can fall up to 1% short, never past the edge.
      await expect
        .poll(async () => (await fillGap(page)).short, { timeout: HIDE_TIMEOUT })
        .toBeLessThan(0.012);
      const gap = await fillGap(page);
      expect(gap.overhang).toBeLessThanOrEqual(0.5);
      expect(gap.offCentre).toBeLessThanOrEqual(2);
      await expect(bar(page)).toHaveCSS("opacity", "1");
      const shown = await box(page);

      // The controls lie over the slide: hiding them frees nothing, so nothing moves.
      await expect(app(page)).toHaveAttribute("data-chrome", "hidden", { timeout: HIDE_TIMEOUT });
      await page.waitForTimeout(300);
      expect((await box(page)).width).toBeCloseTo(shown.width, 0);

      await page.mouse.move(200, 200);
      await page.mouse.move(260, 240);
      await expect(app(page)).toHaveAttribute("data-chrome", "shown");
      await page.waitForTimeout(300);
      expect((await box(page)).width).toBeCloseTo(shown.width, 0);
      expect((await box(page)).y).toBeCloseTo(shown.y, 0);
    });
  });
}

test("in the fill frame the ground around the slide is the slide's own colour, with no card edge", async ({
  page,
}) => {
  await ready(page);
  await present(page);
  const paper = await background(page, ".reveal .slides > section.present .docwalk-slide");
  // On a screen that is not 16:9 the rest of the screen reads as more slide, not as black bars.
  for (const layer of [".docwalk-app", ".docwalk-deck-pane", ".docwalk-deck"])
    expect(await background(page, layer), layer).toBe(paper);
  await expect(card(page)).toHaveCSS("border-radius", "0px");
  await expect(card(page)).toHaveCSS("box-shadow", "none");
  // The bar keeps its own dark strip, so its controls keep their contrast over a white slide.
  expect(await background(page, ".docwalk-preview-head")).not.toBe(paper);
});

test("the card frame is decision 49's stage: dark ground, a margin, a rounded card, the bar above it", async ({
  page,
}) => {
  await useCardFrame(page);
  await ready(page);
  await present(page);
  await expect(app(page)).toHaveAttribute("data-frame", "card");
  const paper = await background(page, ".reveal .slides > section.present .docwalk-slide");
  expect(await background(page, ".docwalk-app")).not.toBe(paper);
  expect(await background(page, ".docwalk-deck")).not.toBe(paper);
  await expect(card(page)).not.toHaveCSS("border-radius", "0px");
  await expect(card(page)).not.toHaveCSS("box-shadow", "none");
  // reveal.js keeps its 10% margin: the slide never reaches the window's edges.
  const { w } = await page.evaluate(() => ({ w: innerWidth }));
  expect((await box(page)).width).toBeLessThanOrEqual(w * 0.9 + 1);
  const head = await bar(page).boundingBox();
  expect((await box(page)).y).toBeGreaterThanOrEqual((head?.y ?? 0) + (head?.height ?? 0));
});

test("Fill the screen is a More menu checkbox, on by default, and the choice is remembered", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "More actions" }).click();
  const item = page.getByRole("menuitemcheckbox", { name: "Fill the screen when presenting" });
  await expect(item).toHaveAttribute("aria-checked", "true");
  await item.click();

  // A presenter who prefers the card should not have to choose it before every talk.
  await page.reload();
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides/, { timeout: 30_000 });
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(item).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await present(page);
  await expect(app(page)).toHaveAttribute("data-frame", "card");
});

test("switching frames from the palette while presenting re-scales the slide and keeps every address", async ({
  page,
}) => {
  await ready(page, "/#summary/1");
  await present(page);
  await expect(app(page)).toHaveAttribute("data-frame", "fill");
  const fillPages = await addresses(page);
  const fillWidth = (await box(page)).width;
  const current = await page.locator(".docwalk-preview-address").textContent();

  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("searchbox").fill("card on a dark stage");
  await palette.getByRole("menuitem", { name: "Presenting: card on a dark stage" }).click();
  await expect(app(page)).toHaveAttribute("data-frame", "card");
  await expect.poll(async () => (await box(page)).width).toBeLessThan(fillWidth * 0.92);

  // Pages are measured on the fixed 1280x720 slide, so the frame changes the
  // scale only: a follower, the presenter window and a link see the same
  // `<section-id>/<n>` in either frame.
  expect(await addresses(page)).toEqual(fillPages);
  await expect(page.locator(".docwalk-preview-address")).toHaveText(current ?? "");
});

test("a fresh load in each frame paginates the document identically", async ({ browser }) => {
  const pagesIn = async (cardFrame: boolean) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    if (cardFrame) await useCardFrame(page);
    await ready(page);
    await present(page);
    await expect(app(page)).toHaveAttribute("data-frame", cardFrame ? "card" : "fill");
    const found = await addresses(page);
    await context.close();
    return found;
  };
  const fill = await pagesIn(false);
  expect(fill.length).toBeGreaterThan(10);
  expect(await pagesIn(true)).toEqual(fill);
});

test("with Always show presenting controls the bar keeps its band instead of covering the slide", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("docwalk.keepPresentControls", "true"));
  await ready(page);
  await present(page);
  await expect(app(page)).toHaveAttribute("data-frame", "fill");
  // Kept up for the whole talk, an overlaid bar would hide the top of every slide.
  await expect
    .poll(async () => {
      const head = await bar(page).boundingBox();
      return (await box(page)).y - ((head?.y ?? 0) + (head?.height ?? 0));
    })
    .toBeGreaterThanOrEqual(-0.5);
  const paper = await background(page, ".reveal .slides > section.present .docwalk-slide");
  expect(await background(page, ".docwalk-deck")).toBe(paper);
});

test("the deck's focus ring is a ring over the slide that fades with the controls, not a border around the screen", async ({
  page,
}) => {
  await ready(page);
  await present(page);
  const reveal = page.locator(".reveal");
  await keyboardFocusDeck(page);
  const ring = () =>
    reveal.evaluate((el) => {
      const after = getComputedStyle(el, "::after");
      return {
        focusVisible: el.matches(":focus-visible"),
        outline: getComputedStyle(el).outlineStyle,
        border: after.borderTopStyle,
        width: Number.parseFloat(after.borderTopWidth),
        inset: Number.parseFloat(after.top),
        opacity: Number(after.opacity),
      };
    });
  // An outline on .reveal ran along the screen's edges, half under the slide, for the whole talk.
  await expect.poll(ring).toMatchObject({ focusVisible: true, outline: "none", border: "solid" });
  const shown = await ring();
  expect(shown.width).toBeGreaterThanOrEqual(2);
  expect(shown.inset).toBeGreaterThan(0);
  expect(shown.opacity).toBe(1);

  // Idle, the room sees the slide alone; the ring leaves with the controls.
  await expect(app(page)).toHaveAttribute("data-chrome", "hidden", { timeout: HIDE_TIMEOUT });
  await expect.poll(async () => (await ring()).opacity).toBe(0);

  // Any key but a navigation key brings the controls, and the ring, back (WCAG 2.4.7).
  await page.keyboard.press("x");
  await expect(app(page)).toHaveAttribute("data-chrome", "shown");
  await expect.poll(async () => (await ring()).opacity).toBe(1);
  await expect(reveal).toBeFocused();
});

test("the card frame keeps the deck's focus outline", async ({ page }) => {
  await useCardFrame(page);
  await ready(page);
  await present(page);
  await keyboardFocusDeck(page);
  await expect(page.locator(".reveal")).toHaveCSS("outline-style", "solid");
  await expect(page.locator(".reveal")).toHaveCSS("outline-width", "2px");
});

test.describe("fill frame on an exactly 16:9 screen", () => {
  // No stage beside the slide: the bar's strip has to be the way back.
  test.use({ viewport: { width: 1280, height: 720 } });

  test("with a drawing tool, the pointer over the slide keeps it clear; the top strip shows the bar", async ({
    page,
  }) => {
    await ready(page);
    await present(page);
    await page.keyboard.press("l");
    await expect(app(page)).toHaveAttribute("data-chrome", "hidden", { timeout: HIDE_TIMEOUT });
    await page.mouse.move(640, 400);
    await page.mouse.move(700, 420, { steps: 4 });
    await page.waitForTimeout(300);
    await expect(app(page)).toHaveAttribute("data-chrome", "hidden");

    await page.mouse.move(640, 8, { steps: 4 });
    await expect(app(page)).toHaveAttribute("data-chrome", "shown");
  });

  test.describe("touch", () => {
    test.use({ hasTouch: true });

    test("with the pen, a tap in the top strip shows the bar", async ({ page }) => {
      await ready(page);
      await present(page);
      await page.getByRole("radio", { name: "Pen" }).tap();
      await expect(app(page)).toHaveAttribute("data-chrome", "hidden", { timeout: HIDE_TIMEOUT });
      await page.touchscreen.tap(640, 400);
      await page.waitForTimeout(300);
      await expect(app(page)).toHaveAttribute("data-chrome", "hidden");

      await page.touchscreen.tap(640, 8);
      await expect(app(page)).toHaveAttribute("data-chrome", "shown");
    });
  });
});

test.describe("fill frame under a notch", () => {
  // iPhone 15 on its side, opened from the Home Screen: insets on both long
  // edges and the home indicator. Only Chromium can emulate safe-area insets
  // (CDP Emulation.setSafeAreaInsetsOverride); Firefox and WebKit have no such switch.
  test.use({ viewport: { width: 852, height: 393 } });

  test("slide content stays inside the safe area, and the insets are painted as slide", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "safe-area insets can only be emulated through CDP");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 0, left: 59, right: 59, bottom: 21 },
    });
    await ready(page);
    await present(page);
    await expect(app(page)).toHaveCSS("padding-left", "59px");
    await expect
      .poll(async () => {
        const b = await box(page);
        return (
          b.x >= 59 - 0.5 && b.x + b.width <= 852 - 59 + 0.5 && b.y + b.height <= 393 - 21 + 0.5
        );
      })
      .toBe(true);
    const paper = await background(page, ".reveal .slides > section.present .docwalk-slide");
    expect(await background(page, ".docwalk-app")).toBe(paper);
  });
});
