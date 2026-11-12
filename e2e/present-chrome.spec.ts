import { deflateRawSync } from "node:zlib";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ready } from "./helpers";

/**
 * Presenting chrome that steps aside (decision 75). On a phone in landscape
 * the bar above the slide and the annotation tools took a third of the
 * screen, and iPhone Safari has no Fullscreen API for pages. These tests
 * guard the trade: the slide gets the stage while nobody touches anything,
 * and nobody (mouse, touch, keyboard, screen reader) loses the controls.
 *
 * Tests that need a stage beside the slide, or a slide that grows when the
 * bar leaves, run in the card frame; the fill frame (decision 77, the
 * default) has its own spec, present-frame.spec.ts.
 */

/** Longer than the 3 s idle delay plus the fade, with room for a slow CI engine. */
const HIDE_TIMEOUT = 10_000;

const app = (page: Page) => page.locator(".docwalk-app");
const bar = (page: Page) => page.locator(".docwalk-preview-head");
const slide = (page: Page) => page.locator(".reveal .slides > section.present");

async function present(page: Page) {
  await ready(page);
  await startPresenting(page);
}

/** Presents the document already open, such as one from a `#doc=` link. */
async function startPresenting(page: Page) {
  await page.getByRole("button", { name: "Present" }).click();
  await expect(app(page)).toHaveAttribute("data-view", "present");
}

/** Decision 49's card on the dark stage, where the bar takes a band above the slide. */
async function useCardFrame(page: Page) {
  await page.addInitScript(() => localStorage.setItem("docwalk.presentCardFrame", "true"));
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
  test.beforeEach(({ page }) => useCardFrame(page));

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
  test.beforeEach(({ page }) => useCardFrame(page));

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
  await useCardFrame(page);
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

/**
 * Opens a document built in the test through a `#doc=` link (decision 7) and
 * waits for its own slide count: the sample can render before the link's
 * document replaces it.
 */
async function openDoc(page: Page, markdown: string, slides: number) {
  await ready(page, `/#doc=${deflateRawSync(Buffer.from(markdown, "utf8")).toString("base64url")}`);
  await expect(page.locator(".docwalk-statusbar")).toContainText(
    new RegExp(`(^|\\D)${slides} slides?`),
  );
}

/** More slides than 99, so the counter reads three digits on both sides ("120 / 120"). */
const LONG_DOC = Array.from({ length: 120 }, (_, i) => `## Slide ${i + 1}\n\nPoint ${i + 1}.`).join(
  "\n\n",
);

/** One slide filled to the bottom: fourteen list lines still fit one page. */
const TALL_SLIDE = `## Tall slide\n\n${Array.from(
  { length: 14 },
  (_, i) => `- Point ${i + 1}: a line of plain text that runs along the slide`,
).join("\n")}\n`;
const SHORT_SLIDE = "## Short slide\n\nOne line.\n";

/**
 * Moves the mouse so the hidden-when-idle bar shows, and waits until it has.
 * With a drawing tool a move over the slide draws instead, and at 667 px the
 * slide spans the width, so such a test moves in the bar's strip (`y` near 0).
 */
async function showChrome(page: Page, y = 200) {
  await page.mouse.move(5, y);
  await page.mouse.move(8, y + 2);
  await expect(app(page)).toHaveAttribute("data-chrome", "shown");
  await expect(bar(page)).toHaveCSS("opacity", "1");
}

/** The bar's visible controls, its box and the slide's, read in one pass. */
function barLayout(page: Page) {
  return page.evaluate(() => {
    const head = document.querySelector(".docwalk-preview-head");
    const slideEl = document.querySelector(".reveal .slides > section.present");
    if (!head || !slideEl) throw new Error("no bar or slide");
    // Runs in the page, so it cannot be moved out of this function.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const box = (el: Element) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, width: b.width, height: b.height };
    };
    const controls = [...head.querySelectorAll("button, label.docwalk-annotate-swatch")]
      .filter((el) => el.checkVisibility({ checkVisibilityCSS: true }))
      .map((el) => ({ name: el.getAttribute("aria-label") ?? el.textContent ?? "", ...box(el) }));
    return {
      controls,
      head: box(head),
      slide: box(slideEl),
      headScroll: head.scrollWidth - head.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
}

/**
 * One row of presenting controls on a narrow head (decision 133). On a phone
 * in landscape the bar took two rows, 120 px, and covered a third of the
 * slide each time it showed. These tests hold the one row at the three
 * phone widths that were measured, with every control still a 44 px target
 * and still reachable, and nothing scrolling sideways.
 */
for (const viewport of [
  { width: 844, height: 390 },
  { width: 734, height: 343 },
  { width: 667, height: 375 },
]) {
  test.describe(`presenting on a ${viewport.width}x${viewport.height} phone in landscape`, () => {
    test.use({ viewport, hasTouch: true });

    test("the controls keep one row of 44 px targets, and the bar covers under 22% of the slide", async ({
      page,
    }) => {
      // The 667 px case also carries a three-digit counter, the widest the row allows for.
      if (viewport.width === 667) {
        await openDoc(page, LONG_DOC, 120);
        await startPresenting(page);
      } else await present(page);
      if (viewport.width === 667) {
        await page.keyboard.press("End");
        await expect(bar(page).locator("strong")).toHaveText("120 / 120");
      }
      await showChrome(page);
      const layout = await barLayout(page);

      const tops = new Set(layout.controls.map((c) => Math.round(c.top)));
      expect(tops.size, JSON.stringify(layout.controls)).toBe(1);
      for (const c of layout.controls) {
        expect(c.width, c.name).toBeGreaterThanOrEqual(44 - 0.01);
        expect(c.height, c.name).toBeGreaterThanOrEqual(44 - 0.01);
      }
      expect(layout.head.height / layout.slide.height).toBeLessThan(0.22);
      // Every control stays on screen: no page scroll, no bar that scrolls sideways.
      expect(layout.pageWidth).toBe(viewport.width);
      expect(layout.headScroll).toBeLessThanOrEqual(0);
    });

    test("Exit is an icon that keeps its name, the address leaves the bar, and Exit still exits", async ({
      page,
    }) => {
      await present(page);
      await showChrome(page);
      // The address stays in the URL and the overview (rule 7); the bar has no room for it.
      await expect(page.locator(".docwalk-preview-address")).toBeHidden();
      const exit = page.getByRole("button", { name: "Exit" });
      const box = await exit.boundingBox();
      expect(box?.width ?? 0).toBeLessThanOrEqual(44 + 0.5);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44 - 0.01);
      await exit.tap();
      await expect(app(page)).not.toHaveAttribute("data-view", "present");
    });

    test("the More tools menu holds Rectangle, Ellipse, Whiteboard and Clear marks, and each works", async ({
      page,
    }) => {
      await present(page);
      await showChrome(page);
      const more = page.getByRole("button", { name: "More tools" });
      await expect(more).toBeVisible();
      for (const name of ["Rectangle", "Ellipse", "Whiteboard", "Clear marks"])
        await expect(
          page.getByRole("radio", { name }).or(page.getByRole("button", { name })),
        ).toBeHidden();

      await more.tap();
      const menu = page.getByRole("menu", { name: "More tools" });
      await expect(menu.getByRole("menuitemradio", { name: /^Rectangle/ })).toBeVisible();
      await expect(menu.getByRole("menuitemradio", { name: /^Ellipse/ })).toBeVisible();
      await expect(menu.getByRole("menuitemcheckbox", { name: /^Whiteboard/ })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Clear marks" })).toBeVisible();

      // A shape picked from the menu becomes the active tool, named on the menu button.
      await menu.getByRole("menuitemradio", { name: /^Rectangle/ }).tap();
      await expect(page.getByRole("button", { name: "More tools: Rectangle" })).toBeVisible();

      // A mark drawn with the pen, then cleared from the menu.
      await page.getByRole("radio", { name: "Pen" }).tap();
      const s = await slide(page).boundingBox();
      if (!s) throw new Error("no slide");
      await page.touchscreen.tap(s.x + s.width / 2, s.y + s.height / 2);
      const marks = page.locator('.docwalk-annotate-draw[data-active="true"] path');
      await expect(marks).not.toHaveCount(0);
      await showChrome(page, 2);
      await page.getByRole("button", { name: "More tools" }).tap();
      await page.getByRole("menuitem", { name: "Clear marks" }).tap();
      await expect(marks).toHaveCount(0);

      // The whiteboard opens from the menu too.
      await showChrome(page, 2);
      await page.getByRole("button", { name: "More tools" }).tap();
      await page.getByRole("menuitemcheckbox", { name: /^Whiteboard/ }).tap();
      await expect(page.locator(".docwalk-annotate[data-board]")).toHaveCount(1);
    });

    test("Shift+Tab from the hidden bar lands on its last visible control", async ({ page }) => {
      await present(page);
      await waitHidden(page);
      await page.locator(".reveal").focus();
      await page.keyboard.press("Shift+Tab");
      // Clear marks waits in the menu here, so the menu button is the last control.
      await expect(page.getByRole("button", { name: "More tools" })).toBeFocused();
    });
  });
}

test.describe("presenting on a phone in Turkish", () => {
  test.use({ viewport: { width: 734, height: 343 }, hasTouch: true, locale: "tr-TR" });

  test("the icon-only Exit keeps its Turkish name", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slayt/, {
      timeout: 30_000,
    });
    await page.locator(".docwalk-present").click();
    await expect(app(page)).toHaveAttribute("data-view", "present");
    await showChrome(page);
    const exit = page.getByRole("button", { name: "Çık" });
    expect((await exit.boundingBox())?.width ?? 0).toBeLessThanOrEqual(44 + 0.5);
    await exit.tap();
    await expect(app(page)).not.toHaveAttribute("data-view", "present");
  });
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
]) {
  test.describe(`presenting at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test("a head wide enough for one row shows the bar as before", async ({ page }) => {
      await present(page);
      await showChrome(page);
      // Exit with its word and its key, the address, and all twelve tools in the bar.
      await expect(page.locator(".docwalk-exit")).toHaveText("Exit Esc");
      await expect(page.locator(".docwalk-preview-address")).toBeVisible();
      await expect(page.getByRole("button", { name: "More tools" })).toBeHidden();
      for (const name of ["Rectangle", "Ellipse"])
        await expect(page.getByRole("radio", { name })).toBeVisible();
      for (const name of ["Whiteboard", "Clear marks"])
        await expect(page.getByRole("button", { name })).toBeVisible();
      const layout = await barLayout(page);
      expect(layout.controls).toHaveLength(14);
      expect(new Set(layout.controls.map((c) => Math.round(c.top))).size).toBe(1);
    });

    test("Exit keeps the button's gap between its word and its key", async ({ page }) => {
      // Before decision 133 the word and the key were the button's own flex
      // items, spaced by its gap; a collapsed space between them made Exit narrower.
      await present(page);
      const { gap, columnGap } = await page.locator(".docwalk-exit").evaluate((button) => {
        const kbd = button.querySelector("kbd");
        const word = [...button.querySelectorAll("*"), button]
          .flatMap((el) => [...el.childNodes])
          .find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim() === "Exit");
        if (!kbd || !word) throw new Error("no word or key");
        const range = document.createRange();
        range.selectNodeContents(word);
        return {
          gap: kbd.getBoundingClientRect().left - range.getBoundingClientRect().right,
          columnGap: Number.parseFloat(getComputedStyle(button).columnGap),
        };
      });
      expect(Math.abs(gap - columnGap), `gap ${gap}, column-gap ${columnGap}`).toBeLessThanOrEqual(
        0.5,
      );
    });
  });
}

/** The icon Exit's tooltip, "Exit Esc". */
const exitTooltip = (page: Page) => page.locator(".docwalk-tooltip").filter({ hasText: "Exit" });

/**
 * One Escape leaves presenting while the icon Exit's tooltip is open. The
 * tooltip ("Exit Esc") stops Escape on its way to the app's handler to close
 * itself; before decision 133 Exit had no tooltip and one Escape left.
 * Windowed, as when fullscreen is refused (iOS, an iframe).
 */
test.describe("Escape with the icon Exit's tooltip open on an 844x390 window", () => {
  test.use({ viewport: { width: 844, height: 390 } });
  test.beforeEach(({ page }) =>
    page.addInitScript(() => {
      Element.prototype.requestFullscreen = () => Promise.reject(new Error("refused"));
    }),
  );

  test("with Exit focused from the keyboard", async ({ page }) => {
    await present(page);
    // From the hidden bar, Tab lands on its first control (decision 75); the next Tab is Exit.
    await waitHidden(page);
    await page.locator(".reveal").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Slide overview" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(".docwalk-exit")).toBeFocused();
    await expect(exitTooltip(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(app(page)).not.toHaveAttribute("data-view", "present");
  });

  test("with the mouse resting on Exit", async ({ page }) => {
    await present(page);
    const box = await page.locator(".docwalk-exit").boundingBox();
    if (!box) throw new Error("no Exit");
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.move(box.x + 20, box.y + 20, { steps: 3 });
    await expect(exitTooltip(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(app(page)).not.toHaveAttribute("data-view", "present");
  });
});

/** The current slide's text lines, images, diagrams, code and tables, as boxes. */
function hintOverlaps(page: Page) {
  return page.evaluate(() => {
    const hint = document.querySelector(".docwalk-chrome-hint")?.getBoundingClientRect();
    const slideEl = document.querySelector(".reveal .slides > section.present");
    if (!hint || !slideEl) throw new Error("no hint or slide");
    const boxes: { text: string; box: DOMRect }[] = [];
    const walker = document.createTreeWalker(slideEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim() ?? "";
      if (!text) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const box of range.getClientRects()) boxes.push({ text, box });
    }
    for (const el of slideEl.querySelectorAll("img, svg, pre, table"))
      boxes.push({ text: el.tagName, box: el.getBoundingClientRect() });
    return boxes
      .filter(
        ({ box }) =>
          box.left < hint.right &&
          hint.left < box.right &&
          box.top < hint.bottom &&
          hint.top < box.bottom,
      )
      .map(({ text }) => text);
  });
}

const HINT_KEY = "docwalk.presentControlsHintSeen";
/**
 * The hint's text now, read once: a retrying `toBeEmpty` would wait out the
 * hint's own 5 s and pass on a hint that did show.
 */
const hintText = (page: Page) => page.locator(".docwalk-chrome-hint").textContent();
const hintSeen = (page: Page) => page.evaluate((key) => localStorage.getItem(key), HINT_KEY);

/**
 * The first-use hint never covers slide content (decision 134). In phone
 * landscape it sat over the last lines of a slide filled to the bottom, the
 * lines the room was reading. It shows only where it covers nothing, and a
 * hint not shown is not counted as seen.
 */
test.describe("the first-use hint on a 734x343 phone in landscape", () => {
  test.use({ viewport: { width: 734, height: 343 }, hasTouch: true });

  test("over a slide filled to the bottom it stays away and is not counted as seen", async ({
    page,
  }) => {
    await openDoc(page, TALL_SLIDE, 1);
    await startPresenting(page);
    await expect(bar(page).locator("strong")).toHaveText("1 / 1");
    await waitHidden(page);
    await page.waitForTimeout(500);
    expect(await hintText(page)).toBe("");
    expect(await hintSeen(page)).toBeNull();
  });

  test("on a short slide it shows, over no content", async ({ page }) => {
    await openDoc(page, SHORT_SLIDE, 1);
    await startPresenting(page);
    await waitHidden(page);
    await expect(page.locator(".docwalk-chrome-hint")).toHaveText(/\S/);
    expect(await hintOverlaps(page)).toEqual([]);
    expect(await hintSeen(page)).toBe("true");
  });

  test("after a full slide, the next hide on a short slide shows it once", async ({ page }) => {
    await openDoc(page, `${TALL_SLIDE}\n${SHORT_SLIDE}`, 2);
    await startPresenting(page);
    await waitHidden(page);
    await page.waitForTimeout(500);
    expect(await hintText(page)).toBe("");

    // A clicker's key moves on and leaves the bar hidden; the next hide tries again.
    await page.keyboard.press("ArrowRight");
    await expect(bar(page).locator("strong")).toHaveText("2 / 2");
    await showChrome(page);
    await waitHidden(page);
    await expect(page.locator(".docwalk-chrome-hint")).toHaveText(/\S/);
    expect(await hintSeen(page)).toBe("true");

    await showChrome(page);
    await waitHidden(page);
    await page.waitForTimeout(500);
    expect(await hintText(page)).toBe("");
  });
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
]) {
  test.describe(`the first-use hint at ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test("shows on the sample's first slide as before", async ({ page }) => {
      await present(page);
      await waitHidden(page);
      await expect(page.locator(".docwalk-chrome-hint")).toHaveText(/\S/);
      expect(await hintOverlaps(page)).toEqual([]);
    });
  });
}
