import { expect, test, type Page } from "@playwright/test";
import { ready } from "./helpers";

/**
 * The header and the stage at the two widths the app is designed for
 * (DESIGN.md, Layout): a laptop and a phone. Overflowing headers and
 * unscaled decks look fine in every unit test and only show in a real page.
 */

async function headerFits(page: Page) {
  const header = page.locator(".docwalk-toolbar");
  const { scrollWidth, clientWidth } = await header.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test("at 1440 px every header action sits on one row", async ({ page }) => {
  await ready(page);
  await headerFits(page);
  const box = await page.locator(".docwalk-toolbar").boundingBox();
  expect(box?.height ?? 0).toBeLessThan(80);
});

test("on a 390 px phone the header fits, actions keep their names, and targets are 44 px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await headerFits(page);
  // Icon-only on a phone, but still named for screen readers and voice control.
  for (const name of ["Open file", "Share", "Export", "More actions", "Present"]) {
    const control = page.getByRole("button", { name, exact: true });
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    // Firefox reports a 44 px box at a fractional offset as 43.999998 px;
    // allow that float error, not a smaller target.
    expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44 - 0.01);
    expect(box?.width ?? 0, name).toBeGreaterThanOrEqual(44 - 0.01);
  }
  // The palette trigger and theme move into the overflow menu instead of disappearing.
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Jump to slide or command" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Theme/ })).toBeVisible();
});

test("presenting on a phone scales the slide to the screen instead of reveal's scroll view", async ({
  page,
}) => {
  // reveal.js switches to a stacked scroll view below 435 px, which showed
  // every slide at full size: pages measured for 1280x720 spilled off-screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  await expect(page.locator(".reveal-viewport.reveal-scroll, .reveal.reveal-scroll")).toHaveCount(
    0,
  );
  // The slide must fit the window it is presented in. That is 390 px in
  // Chromium and WebKit, but headless Firefox sizes a fullscreen page to its
  // own 1366 px screen and ignores the emulated phone, so compare against the
  // window (polled: the fullscreen resize lands after the view flips).
  const overhang = () =>
    page.evaluate(() => {
      const slide = document.querySelector(".reveal .slides > section.present");
      return (slide?.getBoundingClientRect().width ?? Infinity) - innerWidth;
    });
  await expect.poll(overhang).toBeLessThanOrEqual(0);
});
