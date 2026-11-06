import { expect, test, type Page } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

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

test("on a phone the edit view switches between source and a visible slide preview", async ({
  page,
}) => {
  // A phone has no room for the source and the deck side by side, and the
  // stacked layout used to leave the deck far below the editor, where nobody
  // saw the slide they were writing. Preview must put the slide on screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const app = page.locator(".docwalk-app");
  await expect(app).toHaveAttribute("data-pane", "source");
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".docwalk-deck-pane")).toBeHidden();

  await page.getByRole("radio", { name: "Preview" }).click();
  await expect(app).toHaveAttribute("data-pane", "preview");
  await expect(page.locator(".docwalk-source")).toBeHidden();
  const slide = page.locator(".reveal .slides > section.present");
  // Wholly inside the window and above the status bar, without scrolling.
  await expect
    .poll(async () => {
      const box = await slide.boundingBox();
      const bar = await page.locator(".docwalk-statusbar").boundingBox();
      return !!box && !!bar && box.y >= 0 && box.y + box.height <= bar.y && box.width > 300;
    })
    .toBe(true);
  // The switch stays reachable above the pane it controls.
  await expect(page.getByRole("radio", { name: "Source" })).toBeInViewport();

  await page.getByRole("radio", { name: "Source" }).click();
  await expect(page.locator(".cm-content")).toBeInViewport();
  await expect(page.locator(".docwalk-deck-pane")).toBeHidden();
});

test("with the comments panel open at 1440 px the annotation toolbar stays on one row", async ({
  page,
}) => {
  // The comments panel narrows the deck pane. The toolbar used to wrap its
  // undo and clear buttons onto a row of their own, pushing the slide down
  // and splitting a group the presenter reads as one strip.
  await ready(page);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(page.getByRole("complementary", { name: "Comments" })).toBeVisible();
  const tops = await page
    .locator(".docwalk-preview-head .docwalk-stage-tools")
    .locator(".docwalk-annotate-button, .docwalk-annotate-swatch")
    .evaluateAll((els) =>
      els
        .filter((el) => el.getBoundingClientRect().height > 0)
        .map((el) => Math.round(el.getBoundingClientRect().top)),
    );
  expect(tops.length).toBeGreaterThan(5);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(2);
  // The whole head is at most two control rows: counter and address, then the tools.
  const head = await page.locator(".docwalk-preview-head").boundingBox();
  expect(head?.height ?? Infinity).toBeLessThanOrEqual(2 * 38 + 8 + 12 + 1);
});

test("an empty document says how to make a slide instead of showing a blank stage", async ({
  page,
}) => {
  // A blank dark stage with a "…" counter reads as still loading; the empty
  // state has to say it is empty and what to type.
  await ready(page);
  await replaceSource(page, "");
  await expect(page.locator(".docwalk-statusbar")).toContainText("0 slides");
  await expect(page.locator(".docwalk-stage-empty")).toBeVisible();
  await expect(page.locator(".docwalk-preview-head strong")).toHaveText("0 / 0");
});

test("the presenter window lines the current slide up with the next one, under its caption", async ({
  page,
  context,
}) => {
  // The current slide was centred in its tall column and floated 140 px
  // below its "Now" caption, out of line with the next-slide preview, so
  // the eye had to hunt for it between glances at the room.
  await ready(page);
  const popup = context.waitForEvent("page");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popup;
  await presenter.setViewportSize({ width: 1440, height: 900 });
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  // Each preview shows once its page arrives and is scaled into its frame
  // once a ResizeObserver has run; measure after both.
  const tops = () =>
    presenter.evaluate(() =>
      ["current", "next"].map((side) => {
        const el = document.querySelector<HTMLElement>(
          `.docwalk-presenter-${side} .docwalk-presenter-canvas`,
        );
        return el && !el.hidden && !el.style.transform.includes("scale(0)")
          ? Math.round(el.getBoundingClientRect().top)
          : null;
      }),
    );
  await expect.poll(async () => (await tops()).every((t) => t !== null)).toBe(true);
  const [now, next] = await tops();
  expect(Math.abs((now ?? 0) - (next ?? 0))).toBeLessThanOrEqual(2);
});

test("in dark mode a focused diagram keeps the white ground it was drawn for", async ({ page }) => {
  // Mermaid draws dark lines and labels for the white slide. On the dark
  // app canvas the focus view showed them black on near-black.
  await page.emulateMedia({ colorScheme: "dark" });
  await ready(page, "/#proposed-architecture/1");
  await page.locator(".reveal .present .docwalk-diagram").first().click();
  await expect(page.getByRole("dialog", { name: "Diagram, full screen" })).toBeVisible();
  const ground = await page
    .locator(".docwalk-focus-stage")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(ground).toBe("rgb(255, 255, 255)");
});
