import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { docLink, fakeRelay, ready, replaceSource, SHORT_DOC } from "./helpers";

/**
 * The map view's place in the app (decision 142, "Where" and "Budget"): a
 * third choice beside Edit and Document, in the pane the document view uses,
 * with `view=map` in the link and its code in a lazy chunk. What the map
 * draws inside its pane is step 2's later work; here a frame is the section
 * that names it. Follow screens show the map while the presenter does
 * (decision 150, at the end of this file).
 */

const PHONE = { width: 390, height: 844 };
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
// The chunk that holds MapView. Anchored on "/assets/MapView-" so it never
// matches an unrelated chunk such as emojiMap or a Mermaid treemap.
const MAP_CHUNK = /\/assets\/MapView-[^/]+\.js$/;

const app = (page: Page) => page.locator(".docwalk-app");
const mapRegion = (page: Page, name = "Map") => page.getByRole("region", { name, exact: true });
const frames = (page: Page) => mapRegion(page).locator("[data-map-frame]");
const frameIds = (page: Page) =>
  frames(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-map-frame")));

async function expectNoSeriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(serious).toEqual([]);
}

test("Map shows one frame per section of the map's plan, in document order, in place of the deck", async ({
  page,
}) => {
  // The sample has 23 columns and 40 frames (src/map/layout.test.ts). The
  // map's code loads only when asked for: the same pattern perf.spec.ts
  // holds the first load to finds the chunk here, so that check can fail.
  const chunks: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (MAP_CHUNK.test(pathname)) chunks.push(pathname);
  });
  await ready(page);
  expect(chunks, "map chunk before Map is chosen").toEqual([]);
  await page.getByRole("radio", { name: "Map" }).click();
  await expect(app(page)).toHaveAttribute("data-view", "map");
  await expect(page.getByRole("radio", { name: "Map" })).toBeChecked();
  await expect(mapRegion(page)).toBeVisible();
  await expect(frames(page)).toHaveCount(40);
  const ids = await frameIds(page);
  expect(ids[0]).toBe("ledgerline-payment-ledger-redesign");
  await expect(frames(page).first()).toContainText("Ledgerline: payment ledger redesign");
  expect(new Set(ids).size, "every frame once").toBe(40);
  expect(chunks, "map chunk once Map is chosen").toHaveLength(1);
  // The deck stays mounted but hidden, as in the document view.
  await expect(page.locator(".docwalk-deck-pane")).toBeHidden();
  await expect(page.locator(".docwalk-document")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("view")).toBe("map");
});

test("a link with view=map opens the map", async ({ page }) => {
  await ready(page, "/?view=map");
  await expect(app(page)).toHaveAttribute("data-view", "map");
  await expect(page.getByRole("radio", { name: "Map" })).toBeChecked();
  await expect(frames(page)).toHaveCount(40);
});

test("switching between Edit, Document and Map keeps the document and its edits", async ({
  page,
}) => {
  await ready(page, docLink(SHORT_DOC));
  await page.getByRole("radio", { name: "Map" }).click();
  await expect.poll(() => frameIds(page)).toEqual(["round-trip", "first-point", "second-point"]);
  await page.getByRole("radio", { name: "Document" }).click();
  await expect(app(page)).toHaveAttribute("data-view", "document");
  await expect(page.locator(".docwalk-document h2").last()).toHaveText("Second point");
  await expect(mapRegion(page)).toHaveCount(0);
  await page.getByRole("radio", { name: "Edit" }).click();
  await replaceSource(page, `${SHORT_DOC}\n## Third point\n\nGamma.\n`);
  await page.getByRole("radio", { name: "Map" }).click();
  await expect
    .poll(() => frameIds(page))
    .toEqual(["round-trip", "first-point", "second-point", "third-point"]);
  await page.getByRole("radio", { name: "Document" }).click();
  await expect(page.locator(".docwalk-document h2").last()).toHaveText("Third point");
  await page.getByRole("radio", { name: "Edit" }).click();
  await expect(page.locator(".cm-content")).toContainText("Gamma.");
  expect(new URL(page.url()).searchParams.get("view")).toBe("edit");
});

test("the palette's Show map command opens the map", async ({ page }) => {
  await ready(page, docLink(SHORT_DOC));
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("searchbox").fill("Show map");
  await palette.getByRole("menuitem", { name: "Show map" }).click();
  await expect(app(page)).toHaveAttribute("data-view", "map");
  await expect(frames(page)).toHaveCount(3);
});

test("in map view an outline entry moves the outline's mark and stays on the map", async ({
  page,
}) => {
  // As in the document view, the outline names where the reader is; it must
  // not throw the reader back into the editor.
  await ready(page, docLink(SHORT_DOC));
  await page.getByRole("radio", { name: "Map" }).click();
  await expect(frames(page)).toHaveCount(3);
  await page.locator(".docwalk-outline-item", { hasText: "First point" }).click();
  await expect(page.locator(".docwalk-outline-item", { hasText: "First point" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(app(page)).toHaveAttribute("data-view", "map");
});

test("Present from the map presents the deck, and leaving lands in the edit view as from Document", async ({
  page,
}) => {
  await ready(page, docLink(SHORT_DOC));
  await page.getByRole("radio", { name: "Map" }).click();
  await expect(frames(page)).toHaveCount(3);
  await page.getByRole("button", { name: "Present" }).click();
  await expect(app(page)).toHaveAttribute("data-view", "present");
  await expect(page.locator(".reveal .slides > section.present")).toBeVisible();
  await expect(mapRegion(page)).toHaveCount(0);
  await page.getByRole("button", { name: /Exit/ }).click();
  await expect(app(page)).toHaveAttribute("data-view", "edit");
});

test("leaving for the map closes an open whiteboard, as leaving for the document view does", async ({
  page,
}) => {
  // Row 143: the deck pane is hidden on the map, so a board there would be open on nothing.
  await ready(page, docLink(SHORT_DOC));
  const board = page.locator(".docwalk-annotate[data-board]");
  await page.locator(".reveal").focus();
  await page.keyboard.press("w");
  await expect(board).toHaveCount(1);
  await page.getByRole("radio", { name: "Map" }).click();
  await expect(frames(page)).toHaveCount(3);
  await page.getByRole("radio", { name: "Edit" }).click();
  await expect(page.locator(".docwalk-deck-pane")).toBeVisible();
  await expect(board).toHaveCount(0);
});

/** A presenter with a room open; returns the follow link (as in follow-frame.spec.ts). */
async function openRoom(context: BrowserContext) {
  await fakeRelay(context);
  const presenter = await context.newPage();
  await ready(presenter);
  await replaceSource(presenter, SHORT_DOC);
  await expect(presenter.locator(".docwalk-outline-item")).toHaveCount(3);
  await presenter.getByRole("button", { name: "More actions" }).click();
  await presenter.getByRole("menuitem", { name: "Remote and followers…" }).click();
  const dialog = presenter.getByRole("dialog", { name: "Remote control" });
  await expect(dialog.getByText("Room open")).toBeVisible();
  const followUrl = await dialog.getByRole("textbox", { name: "Follow along link" }).inputValue();
  await dialog.getByRole("button", { name: "Close" }).click();
  return { presenter, followUrl };
}

/** The map once its first frame is placed and shown: the view hides the frames until then. */
async function openMap(page: Page, count = 40) {
  await page.getByRole("radio", { name: "Map" }).click();
  await expect(frames(page)).toHaveCount(count);
  await expect(frames(page).first()).toBeVisible({ timeout: 30_000 });
}

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not laid out");
  return box;
};

/** The page's scroll and the map pane's: the camera moves the map, neither of them scrolls. */
const pageScroll = (page: Page) =>
  page.evaluate(() => {
    const pane = document.querySelector(".docwalk-map-pane");
    return {
      x: window.scrollX,
      y: window.scrollY,
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      down: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      pane: (pane?.scrollLeft ?? 0) + (pane?.scrollTop ?? 0),
    };
  });

test("the sample's frames lie in one column; a wheel pans, Ctrl + wheel zooms, and the page never scrolls", async ({
  page,
}) => {
  // Decision 142, Camera: the pane takes the wheel, so the page behind it must not move.
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page);
  await openMap(page);
  const first = frames(page).first();
  // Decision 174: the title's frame, then the first `##` frame right under it:
  // one left edge, one width, the next frame lower down.
  const second = mapRegion(page).locator('[data-map-frame="summary"]');
  const a = await boxOf(first);
  const b = await boxOf(second);
  expect(Math.abs(b.x - a.x)).toBeLessThan(1);
  expect(Math.abs(b.width - a.width)).toBeLessThan(1);
  expect(b.y).toBeGreaterThan(a.y + a.height);
  const pane = await boxOf(mapRegion(page));
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await boxOf(first)).y).toBeLessThan(a.y - 150);
  expect((await boxOf(first)).width).toBeCloseTo(a.width, 1);
  const panned = await boxOf(first);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await boxOf(first)).width).toBeGreaterThan(panned.width * 1.05);
  expect(await pageScroll(page)).toEqual({ x: 0, y: 0, sideways: 0, down: 0, pane: 0 });
});

test.describe("on a 390 × 844 phone", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("the map opens with the first frame fitted to the width, and one finger pans it", async ({
    page,
    context,
    browserName,
  }) => {
    await ready(page);
    await openMap(page);
    const pane = await boxOf(mapRegion(page));
    const first = await boxOf(frames(page).first());
    // Small text, but the whole width of the frame is on the screen (decision 142).
    expect(first.x).toBeGreaterThanOrEqual(pane.x);
    expect(first.x + first.width).toBeLessThanOrEqual(pane.x + pane.width);
    // Fitted inside the 24 px margin: 1280 units drawn 342 px wide.
    expect(Math.abs(first.width - (pane.width - 48))).toBeLessThan(1);
    expect(first.x + first.width).toBeLessThanOrEqual(PHONE.width);
    expect(await pageScroll(page)).toEqual({ x: 0, y: 0, sideways: 0, down: 0, pane: 0 });
    // A real touch drag needs the DevTools protocol; other engines rely on the browser tests.
    test.skip(browserName !== "chromium", "touch drags are sent through CDP in Chromium only");
    const cdp = await context.newCDPSession(page);
    const x = pane.x + pane.width / 2;
    const y = pane.y + pane.height / 2;
    const send = (type: "touchStart" | "touchMove" | "touchEnd", dy: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y: y + dy }],
      });
    await send("touchStart", 0);
    for (let i = 1; i <= 10; i++) await send("touchMove", -15 * i);
    await send("touchEnd", -150);
    await expect
      .poll(async () => (await boxOf(frames(page).first())).y)
      .toBeLessThan(first.y - 100);
    expect(await pageScroll(page)).toEqual({ x: 0, y: 0, sideways: 0, down: 0, pane: 0 });
  });
});

/**
 * One finger from (x, y) moved by (dx, dy) in ten steps, through the DevTools
 * protocol: a trusted touch, so the browser applies `touch-action` and may
 * take the gesture for itself (pointercancel), which synthetic events cannot show.
 */
async function touchPan(
  context: BrowserContext,
  page: Page,
  x: number,
  y: number,
  dx: number,
  dy: number,
) {
  const cdp = await context.newCDPSession(page);
  const at = (i: number) => [{ x: x + (dx * i) / 10, y: y + (dy * i) / 10 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) });
  for (let i = 1; i <= 10; i++)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(i) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

for (const [label, viewport] of [
  ["a 390 × 844 phone", PHONE],
  ["a 1440 × 900 touch screen", { width: 1440, height: 900 }],
] as const) {
  test.describe(`one finger on a frame's text on ${label}`, () => {
    test.use({ viewport, hasTouch: true });

    test("pans the map, as on empty map (decision 144)", async ({ page, context, browserName }) => {
      // A frame's body scrolls on its own (overflow: auto), so the pane's
      // touch-action does not reach it unless its content says so too.
      test.skip(browserName !== "chromium", "touch drags are sent through CDP in Chromium only");
      await ready(page);
      await openMap(page);
      const text = await boxOf(frames(page).first().locator(".docwalk-slide-body p").first());
      const before = await boxOf(frames(page).first());
      await touchPan(context, page, text.x + 10, text.y + text.height / 2, 0, -150);
      await expect
        .poll(async () => (await boxOf(frames(page).first())).y)
        .toBeLessThan(before.y - 100);
      expect(await pageScroll(page)).toEqual({ x: 0, y: 0, sideways: 0, down: 0, pane: 0 });
    });
  });
}

const WIDE_DOC = [
  "## Wide",
  "",
  "```text",
  `log ${"key=value ".repeat(60)}`,
  "```",
  "",
  `| ${Array.from({ length: 14 }, (_, i) => `Column ${i + 1}`).join(" | ")} |`,
  `|${" --- |".repeat(14)}`,
  `| ${Array.from({ length: 14 }, () => "a long cell value").join(" | ")} |`,
  "",
  "## Next",
  "",
  "Text.",
  "",
].join("\n");

test.describe("one finger on a box that scrolls sideways inside a frame", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  for (const selector of ["pre", "table"]) {
    test(`on a ${selector} pans the map and scrolls nothing in place (decision 144)`, async ({
      page,
      context,
      browserName,
    }) => {
      test.skip(browserName !== "chromium", "touch drags are sent through CDP in Chromium only");
      await ready(page, docLink(WIDE_DOC));
      await openMap(page, 2);
      const frame = mapRegion(page).locator('[data-map-frame="wide"]');
      const box = frame.locator(selector).first();
      // The test means something only if the box, or the body around it, really scrolls.
      const scrolls = await box.evaluate((el) => {
        const body = el.closest(".docwalk-slide-body")!;
        return el.scrollWidth > el.clientWidth || body.scrollWidth > body.clientWidth;
      });
      expect(scrolls).toBe(true);
      const at = await boxOf(box);
      const before = await boxOf(frame);
      await touchPan(context, page, at.x + at.width / 2, at.y + at.height / 2, -120, 0);
      await expect.poll(async () => (await boxOf(frame)).x).toBeLessThan(before.x - 80);
      const scrolled = await box.evaluate(
        (el) => el.scrollLeft + el.closest(".docwalk-slide-body")!.scrollLeft,
      );
      expect(scrolled).toBe(0);
    });
  }
});

test.describe("at 800 × 900, where the main area scrolls", () => {
  test.use({ viewport: { width: 800, height: 900 } });

  test("Tab to a link in a far frame moves the camera and scrolls no ancestor", async ({
    page,
  }) => {
    // Between 641 and 900 px `.docwalk-main` is overflow: auto; focusing an
    // element far off the map must not scroll it and leave the app shifted.
    const far = [
      ...["One", "Two", "Three", "Four", "Five", "Six"].flatMap((name) => [
        `## Column ${name}`,
        "",
        `${name} text.`,
        "",
      ]),
      "## Last",
      "",
      "Read [the far link](https://example.invalid/far) here.",
      "",
    ].join("\n");
    await ready(page, docLink(far));
    await page.getByRole("radio", { name: "Map" }).click();
    await expect(frames(page).first()).toBeVisible({ timeout: 30_000 });
    await mapRegion(page).focus();
    await page.keyboard.press("Tab");
    const link = page.getByRole("link", { name: "the far link" });
    await expect(link).toBeFocused();
    const pane = await boxOf(mapRegion(page));
    await expect
      .poll(async () => {
        const b = await boxOf(link);
        return (
          b.x >= pane.x &&
          b.y >= pane.y &&
          b.x + b.width <= pane.x + pane.width &&
          b.y + b.height <= pane.y + pane.height
        );
      })
      .toBe(true);
    const scrolled = await mapRegion(page).evaluate((el) => {
      const moved: string[] = [];
      for (let node: Element | null = el; node; node = node.parentElement)
        if (node.scrollTop !== 0 || node.scrollLeft !== 0)
          moved.push(`${node.className || node.tagName}: ${node.scrollLeft},${node.scrollTop}`);
      return moved;
    });
    expect(scrolled).toEqual([]);
  });
});

test("axe finds no serious violations in the map view", async ({ page }) => {
  await ready(page);
  await page.getByRole("radio", { name: "Map" }).click();
  await expect(frames(page)).toHaveCount(40);
  await expectNoSeriousViolations(page);
});

/**
 * Whether a radio shows its word: some text in it sits in a box wider than a
 * pixel that no clip-path hides. A visually hidden label still names the radio.
 */
const showsWord = (radio: Locator) =>
  radio.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim()) continue;
      const style = getComputedStyle(parent);
      if (style.display !== "none" && style.clipPath === "none" && parent.offsetWidth > 1)
        return true;
    }
    return false;
  });

for (const [language, locale, names, more, present] of [
  ["English", "en-US", ["Edit", "Document", "Map"], "More actions", "Present"],
  ["Turkish", "tr-TR", ["Düzenle", "Belge", "Harita"], "Diğer işlemler", "Sunum yap"],
] as const) {
  test.describe(`on a 390 px phone in ${language}`, () => {
    test.use({ locale, viewport: PHONE });

    test("the view choices are 44 px icons named by their words, and nothing runs off the screen", async ({
      page,
    }) => {
      // Row 143: three words did not fit a 390 px header (423 px in English,
      // 432 px in Turkish), so More actions and Present ran past the edge.
      await page.goto("/");
      await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ (slides?|slayt)/, {
        timeout: 30_000,
      });
      const sideways = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
      for (const name of names) {
        const radio = page.getByRole("radio", { name, exact: true });
        await expect(radio).toBeVisible();
        const box = await radio.boundingBox();
        // A 44 px touch target (DESIGN.md); Firefox reports 43.999998 px at a fractional offset.
        expect(box?.width ?? 0, name).toBeGreaterThanOrEqual(44 - 0.01);
        expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44 - 0.01);
        expect(box?.width ?? 0, `${name} is an icon, not a word`).toBeLessThan(60);
        expect(await showsWord(radio), `${name} shows no word`).toBe(false);
      }
      // The app clips what overflows, so the page alone cannot show a header
      // pushed wider than the screen: the last controls must end inside it too.
      for (const control of [
        page.getByRole("radio", { name: names[2], exact: true }),
        page.getByRole("button", { name: more, exact: true }),
        page.getByRole("button", { name: present, exact: true }),
      ])
        await expect(control).toBeInViewport({ ratio: 1 });
      expect(await sideways(), "edit view").toBeLessThanOrEqual(0);
      await page.getByRole("radio", { name: names[2], exact: true }).click();
      await expect(app(page)).toHaveAttribute("data-view", "map");
      await expect(page.locator("[data-map-frame]")).toHaveCount(40);
      expect(await sideways(), "map view").toBeLessThanOrEqual(0);
    });
  });
}

test("at 1280 px the view choices show their words", async ({ page }) => {
  // Only a narrow screen trades the words for icons (row 143).
  await page.setViewportSize({ width: 1280, height: 800 });
  await ready(page);
  for (const name of ["Edit", "Document", "Map"]) {
    const radio = page.getByRole("radio", { name, exact: true });
    await expect(radio).toHaveText(name);
    expect(await showsWord(radio), `${name} shows its word`).toBe(true);
  }
});

test.describe("in Turkish", () => {
  test.use({ locale: "tr-TR" });

  test("the choice, the region and the command say Harita", async ({ page }) => {
    await page.goto(docLink(SHORT_DOC));
    await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slayt/, {
      timeout: 30_000,
    });
    await page.getByRole("radio", { name: "Harita" }).click();
    await expect(mapRegion(page, "Harita")).toBeVisible();
    await page.getByRole("radio", { name: "Belge" }).click();
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Komut paleti" });
    await palette.getByRole("searchbox").fill("Haritayı göster");
    await palette.getByRole("menuitem", { name: "Haritayı göster" }).click();
    await expect(app(page)).toHaveAttribute("data-view", "map");
  });
});

/**
 * The route (decision 145): a current frame, keys, the camera's move and the
 * slide address. The sample's third column is "Goals and non-goals" with two
 * `###` frames under it; the deck at `auto` shows them inside that slide.
 */
const current = (page: Page) => mapRegion(page).locator('[data-map-frame][aria-current="true"]');
const hash = (page: Page) => page.evaluate(() => location.hash);
const outlineMark = (page: Page) => page.locator('.docwalk-outline-item[aria-selected="true"]');

/**
 * Two animation frames: the deck's slide change and the address it writes
 * happen in the key's own task, so a hash read after this is the settled one.
 */
const afterFrames = (page: Page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

/** Whether the box lies inside the map's pane (its whole width, its top). */
async function inPane(page: Page, locator: Locator) {
  const pane = await boxOf(mapRegion(page));
  const box = await boxOf(locator);
  return (
    box.x >= pane.x - 1 &&
    box.x + box.width <= pane.x + pane.width + 1 &&
    box.y >= pane.y - 1 &&
    box.y < pane.y + pane.height
  );
}

/** Opens `path` in the map view and waits for its current frame to be placed. */
async function openAt(page: Page, path: string, id: string) {
  await ready(page, path);
  await expect(app(page)).toHaveAttribute("data-view", "map");
  await expect(current(page)).toHaveAttribute("data-map-frame", id, { timeout: 30_000 });
  await expect.poll(() => inPane(page, current(page)), { timeout: 30_000 }).toBe(true);
}

test.describe("the route through the sample", () => {
  test.describe("with reduced motion", () => {
    test.use({ reducedMotion: "reduce" });

    test("Right steps through a column's ### frames with the address unchanged, and the next column moves it", async ({
      page,
    }) => {
      await openAt(page, "/?view=map#goals-and-non-goals/1", "goals-and-non-goals");
      await mapRegion(page).focus();
      for (const id of ["goals", "non-goals"]) {
        await page.keyboard.press("ArrowRight");
        await expect(current(page)).toHaveAttribute("data-map-frame", id);
        await expect.poll(() => inPane(page, current(page))).toBe(true);
        await afterFrames(page);
        // reveal.js stays where the map put it: the slide is the column's.
        expect(await hash(page)).toBe("#goals-and-non-goals/1");
      }
      await page.keyboard.press("ArrowRight");
      await expect(current(page)).toHaveAttribute("data-map-frame", "glossary");
      await expect.poll(() => hash(page)).toBe("#glossary/1");
      await expect(outlineMark(page)).toContainText("Glossary");
      await expect(mapRegion(page).getByRole("status")).toHaveText("Glossary, 6 of 40");
    });

    test("0 shows the whole map, first frame to last, and Enter returns to the current frame", async ({
      page,
    }) => {
      await openAt(page, "/?view=map#summary/1", "summary");
      await mapRegion(page).focus();
      await page.keyboard.press("0");
      const last = mapRegion(page).locator('[data-map-frame="changelog"]');
      await expect.poll(() => inPane(page, last)).toBe(true);
      // Decision 174: the whole map is the one column fitted to the pane, top frame to last.
      expect(await inPane(page, frames(page).first())).toBe(true);
      const whole = await boxOf(current(page));
      await page.keyboard.press("Enter");
      await expect
        .poll(async () => (await boxOf(current(page))).width)
        .toBeGreaterThan(whole.width * 3);
      await expect.poll(() => inPane(page, current(page))).toBe(true);
      await expect(current(page)).toHaveAttribute("data-map-frame", "summary");
    });

    test("an outline entry in the map view moves the map to that section's frame", async ({
      page,
    }) => {
      await openAt(page, "/?view=map", "ledgerline-payment-ledger-redesign");
      const target = mapRegion(page).locator('[data-map-frame="observability"]');
      expect(await inPane(page, target)).toBe(false);
      await page.locator(".docwalk-outline-item", { hasText: "Observability" }).click();
      await expect(current(page)).toHaveAttribute("data-map-frame", "observability");
      await expect.poll(() => inPane(page, target)).toBe(true);
      await expect(app(page)).toHaveAttribute("data-view", "map");
    });

    test("the outline entry of the column the reader is in moves the map back to its head (148)", async ({
      page,
    }) => {
      // The deck is already on "Goals and non-goals"; the choice still moves the map.
      await openAt(page, "/?view=map#goals-and-non-goals/1", "goals-and-non-goals");
      await mapRegion(page).focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(current(page)).toHaveAttribute("data-map-frame", "non-goals");
      const head = mapRegion(page).locator('[data-map-frame="goals-and-non-goals"]');
      await expect.poll(() => inPane(page, head)).toBe(false);
      await page.locator(".docwalk-outline-item", { hasText: "Goals and non-goals" }).click();
      await expect(current(page)).toHaveAttribute("data-map-frame", "goals-and-non-goals");
      await expect.poll(() => inPane(page, head)).toBe(true);
    });

    test("a ### frame sets the address to its section's first page (148)", async ({ page }) => {
      // Pages come from measured pagination, so the map names the section, and
      // the deck goes to its first page, whichever page the frame's text is on.
      await openAt(page, "/?view=map#glossary/1", "glossary");
      await mapRegion(page).focus();
      await page.keyboard.press("ArrowLeft");
      await expect(current(page)).toHaveAttribute("data-map-frame", "non-goals");
      await expect.poll(() => hash(page)).toBe("#goals-and-non-goals/1");
    });

    test("a link to a later section with view=map opens on its frame", async ({ page }) => {
      await openAt(page, "/?view=map#observability/1", "observability");
      expect(await hash(page)).toBe("#observability/1");
    });

    test("Edit after moving on the map shows the deck on the map's section", async ({ page }) => {
      await openAt(page, "/?view=map", "ledgerline-payment-ledger-redesign");
      await mapRegion(page).focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => hash(page)).toBe("#goals-and-non-goals/1");
      await page.getByRole("radio", { name: "Edit" }).click();
      await expect(page.locator(".reveal .slides > section.present")).toHaveAttribute(
        "data-docwalk-id",
        "goals-and-non-goals",
      );
      expect(await hash(page)).toBe("#goals-and-non-goals/1");
    });

    test("a slide found in the palette moves the map to its frame", async ({ page }) => {
      await openAt(page, "/?view=map", "ledgerline-payment-ledger-redesign");
      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("searchbox").fill("14:03 last Tuesday");
      await palette.getByRole("menuitem").filter({ hasText: "Summary" }).first().click();
      await expect(current(page)).toHaveAttribute("data-map-frame", "summary");
      await expect.poll(() => inPane(page, current(page))).toBe(true);
    });

    test("keys do nothing on the map while the palette or a dialog is open", async ({ page }) => {
      await openAt(page, "/?view=map#summary/1", "summary");
      await mapRegion(page).focus();
      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await expect(palette).toBeVisible();
      await expect(mapRegion(page)).not.toBeFocused();
      await expect(palette.getByRole("searchbox")).toBeFocused();
      for (const key of ["ArrowRight", "End", "0", "PageDown"]) await page.keyboard.press(key);
      // The search box took the "0": the first Escape clears it, the second closes.
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();
      await page.getByRole("button", { name: "Share" }).click();
      const share = page.getByRole("dialog");
      await expect(share).toBeVisible();
      await expect(mapRegion(page)).not.toBeFocused();
      for (const key of ["ArrowRight", "End", "0"]) await page.keyboard.press(key);
      await share.getByRole("button", { name: "Close" }).click();
      await expect(share).toBeHidden();
      await expect(current(page)).toHaveAttribute("data-map-frame", "summary");
      expect(await hash(page)).toBe("#summary/1");
    });

    test("a frame whose section the reader left out moves the map and leaves the deck where it was", async ({
      page,
    }) => {
      // Row 142: the choice of sections does not change the map. The deck has
      // no slide for "Goals and non-goals" here, so going there is a no-op for
      // the deck and the address keeps the slide it shows.
      await openAt(page, "/?view=map&sections=summary,glossary#summary/1", "summary");
      await mapRegion(page).focus();
      await page.keyboard.press("ArrowRight");
      await expect(current(page)).toHaveAttribute("data-map-frame", "goals-and-non-goals");
      await expect.poll(() => inPane(page, current(page))).toBe(true);
      await afterFrames(page);
      expect(await hash(page)).toBe("#summary/1");
      await expect(outlineMark(page)).toContainText("Summary");
      // The next section the deck has moves it again.
      for (const key of ["ArrowRight", "ArrowRight", "ArrowRight"]) await page.keyboard.press(key);
      await expect(current(page)).toHaveAttribute("data-map-frame", "glossary");
      await expect.poll(() => hash(page)).toBe("#glossary/1");
    });

    test("axe finds no serious violations with a current frame announced", async ({ page }) => {
      await openAt(page, "/?view=map", "ledgerline-payment-ledger-redesign");
      await mapRegion(page).focus();
      await page.keyboard.press("ArrowRight");
      await expect(mapRegion(page).getByRole("status")).toHaveText("Summary, 2 of 40");
      await expectNoSeriousViolations(page);
    });
  });

  test("without reduced motion the camera passes in-between places and arrives", async ({
    page,
  }) => {
    // No wall-clock budget: CI's timing varies. The move must animate and land.
    await openAt(page, "/?view=map", "ledgerline-payment-ledger-redesign");
    await mapRegion(page).focus();
    await page.evaluate(() => {
      const layer = document.querySelector<HTMLElement>(".docwalk-map-layer")!;
      const seen = new Set<string>();
      (window as unknown as { mapSeen: Set<string> }).mapSeen = seen;
      const record = () => {
        seen.add(layer.style.transform);
        requestAnimationFrame(record);
      };
      record();
    });
    await page.keyboard.press("End");
    await expect(current(page)).toHaveAttribute("data-map-frame", "changelog");
    await expect.poll(() => inPane(page, current(page))).toBe(true);
    const seen = await page.evaluate(
      () => (window as unknown as { mapSeen: Set<string> }).mapSeen.size,
    );
    // The start, the end and at least one place between them.
    expect(seen).toBeGreaterThanOrEqual(3);
  });
});

const laserDot = (page: Page) => mapRegion(page).locator(".docwalk-map-laser circle");
/** The map layer's camera as the view wrote it. */
const layerTransform = (page: Page) =>
  page.locator(".docwalk-map-layer").evaluate((el) => (el as HTMLElement).style.transform);

test.describe("the map's laser (decision 149)", () => {
  test("L shows the dot under the mouse, a drag points and pans nothing, and leaving the map switches it off", async ({
    page,
  }) => {
    // The short document: the sample's diagrams and fonts can still move the camera after it shows.
    await ready(page, docLink(SHORT_DOC));
    await openMap(page, 3);
    await mapRegion(page).focus();
    await page.keyboard.press("l");
    await expect(mapRegion(page)).toHaveAttribute("data-laser", "");
    await expect(mapRegion(page).getByRole("status")).toHaveText("Laser on");
    const pane = await boxOf(mapRegion(page));
    const at = { x: pane.x + pane.width * 0.4, y: pane.y + pane.height * 0.5 };
    await page.mouse.move(at.x, at.y);
    const dot = await boxOf(laserDot(page));
    expect(Math.abs(dot.x + dot.width / 2 - at.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(dot.y + dot.height / 2 - at.y)).toBeLessThanOrEqual(1);
    // With the laser off this drag would pan the map (decision 142).
    const before = await layerTransform(page);
    await page.mouse.down();
    await page.mouse.move(at.x + 200, at.y + 100, { steps: 10 });
    await page.mouse.up();
    await afterFrames(page);
    expect(await layerTransform(page)).toBe(before);
    await page.mouse.move(pane.x + pane.width + 50, pane.y - 50);
    await expect(laserDot(page)).toHaveCount(0);
    await page.getByRole("radio", { name: "Document" }).click();
    await page.getByRole("radio", { name: "Map" }).click();
    await expect(frames(page).first()).toBeVisible({ timeout: 30_000 });
    await expect(mapRegion(page)).not.toHaveAttribute("data-laser");
  });

  test("the palette offers the laser only on the map and switches it both ways", async ({
    page,
  }) => {
    await ready(page, docLink(SHORT_DOC));
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await page.keyboard.press("ControlOrMeta+k");
    await palette.getByRole("searchbox").fill("laser");
    await expect(palette.getByRole("menuitem", { name: /laser/i })).toHaveCount(0);
    // Escape on a filled search box clears it; on an empty one it closes the palette.
    await palette.getByRole("searchbox").fill("");
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await page.getByRole("radio", { name: "Map" }).click();
    await expect(frames(page)).toHaveCount(3);
    await page.keyboard.press("ControlOrMeta+k");
    await palette.getByRole("searchbox").fill("laser");
    await palette.getByRole("menuitem", { name: "Turn on laser" }).click();
    await expect(mapRegion(page)).toHaveAttribute("data-laser", "");
    await expect(mapRegion(page).getByRole("status")).toHaveText("Laser on");
    await page.keyboard.press("ControlOrMeta+k");
    await palette.getByRole("searchbox").fill("laser");
    await palette.getByRole("menuitem", { name: "Turn off laser" }).click();
    await expect(mapRegion(page)).not.toHaveAttribute("data-laser");
    await expect(mapRegion(page).getByRole("status")).toHaveText("Laser off");
  });

  test("axe finds no serious violations with the laser on and its dot shown", async ({ page }) => {
    await ready(page);
    await openMap(page);
    await mapRegion(page).focus();
    await page.keyboard.press("l");
    const pane = await boxOf(mapRegion(page));
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    await expect(laserDot(page)).toHaveCount(1);
    await expectNoSeriousViolations(page);
  });
});

const backButton = (page: Page) =>
  mapRegion(page).getByRole("button", { name: "Back to presenter" });
const presentSlide = (page: Page) => page.locator(".reveal .slides > section.present");
/** Calls to `WebSocket.prototype.send` on the page since it loaded. */
const sent = (page: Page) => page.evaluate(() => Number(Reflect.get(window, "__docwalkSent")));

test.describe("a follow screen while the presenter is on the map (decision 150)", () => {
  // Only where the camera ends matters here, never the move on its way.
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("the follower shows the map on the presenter's section, roams on its own, comes back, and returns to the presenter's slide", async ({
    context,
  }) => {
    const { presenter, followUrl } = await openRoom(context);
    const follower = await context.newPage();
    // Every message the follower sends, to show that roaming sends none.
    await follower.addInitScript(() => {
      const send = WebSocket.prototype.send;
      Reflect.set(window, "__docwalkSent", 0);
      WebSocket.prototype.send = function (this: WebSocket, data) {
        Reflect.set(window, "__docwalkSent", Number(Reflect.get(window, "__docwalkSent")) + 1);
        send.call(this, data);
      };
    });
    const chunks: string[] = [];
    follower.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (MAP_CHUNK.test(pathname)) chunks.push(pathname);
    });
    await ready(follower, followUrl);
    await expect(app(follower)).toHaveAttribute("data-view", "follow");
    await expect(presentSlide(follower)).toBeVisible();
    expect(chunks, "the map's chunk before the presenter is on the map").toEqual([]);
    await expect(follower.getByRole("radio", { name: "Map" })).toHaveCount(0);

    // The presenter enters the map: the follower shows it, on the presenter's frame.
    await presenter.bringToFront();
    await presenter.getByRole("radio", { name: "Map" }).click();
    await expect(frames(presenter)).toHaveCount(3);
    const opening = await current(presenter).getAttribute("data-map-frame");
    await expect(frames(follower)).toHaveCount(3);
    await expect(current(follower)).toHaveAttribute("data-map-frame", opening!);
    await expect(app(follower)).toHaveAttribute("data-view", "follow");
    await expect(follower.locator(".docwalk-deck-pane")).toBeHidden();
    // Around the map: the follow status and the theme button, no header and no view switch.
    await expect(follower.getByText("Following the presenter", { exact: true })).toBeVisible();
    await expect(follower.getByRole("button", { name: /^Theme:/ })).toBeVisible();
    await expect(follower.getByRole("radio", { name: "Map" })).toHaveCount(0);
    expect(chunks, "the map's chunk once the presenter is on it").toHaveLength(1);
    await expect(backButton(follower)).toHaveCount(0);
    await expectNoSeriousViolations(follower);

    // The paste left the presenter on the last slide: Home goes to the first frame,
    // then Right steps into the next column. The follower's map moves with each.
    await mapRegion(presenter).focus();
    await presenter.keyboard.press("Home");
    const first = await current(presenter).getAttribute("data-map-frame");
    expect(first).not.toBe(opening);
    await expect(current(follower)).toHaveAttribute("data-map-frame", first!);
    await presenter.keyboard.press("ArrowRight");
    const second = await current(presenter).getAttribute("data-map-frame");
    expect(second).not.toBe(first);
    await expect(current(follower)).toHaveAttribute("data-map-frame", second!);
    await expect.poll(() => inPane(follower, current(follower))).toBe(true);

    // The follower pans: a roam. The presenter's next step no longer moves the follower's map.
    const sentBefore = await sent(follower);
    await follower.bringToFront();
    const pane = await boxOf(mapRegion(follower));
    await follower.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    await follower.mouse.wheel(0, 200);
    await expect(backButton(follower)).toBeVisible();
    await expectNoSeriousViolations(follower);
    const held = await layerTransform(follower);
    await presenter.bringToFront();
    await presenter.keyboard.press("ArrowRight");
    const third = await current(presenter).getAttribute("data-map-frame");
    expect(third).not.toBe(second);
    // The follower's deck, hidden, still goes to the presenter's slide.
    await expect(presentSlide(follower)).toHaveAttribute("data-docwalk-id", third!);
    await follower.bringToFront();
    await afterFrames(follower);
    expect(await layerTransform(follower)).toBe(held);
    await expect(current(follower)).toHaveAttribute("data-map-frame", second!);

    // The button: back on the presenter's frame, and the button goes.
    await backButton(follower).click();
    await expect(current(follower)).toHaveAttribute("data-map-frame", third!);
    await expect(backButton(follower)).toHaveCount(0);
    await expect.poll(() => inPane(follower, current(follower))).toBe(true);

    // Roam again, by a route key this time, and come back with Escape.
    await mapRegion(follower).focus();
    await follower.keyboard.press("Home");
    await expect(current(follower)).toHaveAttribute("data-map-frame", first!);
    await expect(backButton(follower)).toBeVisible();
    await follower.keyboard.press("Escape");
    await expect(current(follower)).toHaveAttribute("data-map-frame", third!);
    await expect(backButton(follower)).toHaveCount(0);
    expect(await sent(follower), "roaming sends nothing").toBe(sentBefore);

    // The follower roams away, and the presenter goes back to Edit: the follower shows
    // the slides again on the presenter's slide, not on the frame it roamed to.
    await follower.keyboard.press("Home");
    await expect(backButton(follower)).toBeVisible();
    await presenter.bringToFront();
    await presenter.getByRole("radio", { name: "Edit" }).click();
    await follower.bringToFront();
    await expect(follower.locator("[data-map-frame]")).toHaveCount(0);
    await expect(follower.locator(".docwalk-deck-pane")).toBeVisible();
    await expect(presentSlide(follower)).toBeVisible();
    await expect(presentSlide(follower)).toHaveAttribute("data-docwalk-id", third!);
    expect(await sent(follower), "roaming sends nothing").toBe(sentBefore);

    // Back on the map later: following, with no roam left over.
    await presenter.bringToFront();
    await presenter.getByRole("radio", { name: "Map" }).click();
    await follower.bringToFront();
    await expect(current(follower)).toHaveAttribute("data-map-frame", third!);
    await expect(backButton(follower)).toHaveCount(0);
  });
});

test.describe("the presenter's marks while a follower shows the map (decision 150)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("the mirror layer hides with the deck, the board's closing op on the way to the map throws nothing, and the marks are back on slides", async ({
    context,
  }) => {
    const { presenter, followUrl } = await openRoom(context);
    await presenter.locator(".docwalk-outline-item").first().click();
    await expect(presenter.locator(".docwalk-preview-head strong")).toHaveText("1 / 3");
    const follower = await context.newPage();
    const errors: string[] = [];
    follower.on("pageerror", (error) => errors.push(error.message));
    await ready(follower, followUrl);
    await expect(follower.locator(".docwalk-preview-head strong").first()).toHaveText("1 / 3");
    const mirror = follower.locator(".docwalk-mirror");
    const marks = follower.locator(".docwalk-mirror [data-mark]");

    // A pen stroke on the first slide reaches the follower (decision 88).
    await presenter.bringToFront();
    await presenter.getByRole("radio", { name: "Pen" }).click();
    const r = await boxOf(presenter.locator(".docwalk-annotate"));
    await presenter.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.4);
    await presenter.mouse.down();
    await presenter.mouse.move(r.x + r.width * 0.6, r.y + r.height * 0.5, { steps: 14 });
    await presenter.mouse.up();
    await expect(marks).toHaveCount(1);
    await expect(marks.first()).toBeVisible();

    // A whiteboard open on the way to the map: leaving for the map closes it (row 143),
    // and that close reaches the follower as a mirror op around the switch.
    await presenter.locator(".reveal").focus();
    await presenter.keyboard.press("w");
    await expect(presenter.locator(".docwalk-annotate[data-board]")).toHaveCount(1);
    await presenter.getByRole("radio", { name: "Map" }).click();
    await expect(frames(presenter)).toHaveCount(3);
    await follower.bringToFront();
    await expect(frames(follower)).toHaveCount(3);
    // Drawn in slide units on the deck's stage, the mirror is not shown on the map.
    await expect(mirror).toBeHidden();
    await expect(marks.first()).toBeHidden();

    // Both back on slides: the follower's marks show again, on the presenter's slide.
    await presenter.bringToFront();
    await presenter.getByRole("radio", { name: "Edit" }).click();
    await follower.bringToFront();
    await expect(follower.locator("[data-map-frame]")).toHaveCount(0);
    await expect(presentSlide(follower)).toBeVisible();
    await expect(mirror).toBeVisible();
    await expect(marks).toHaveCount(1);
    await expect(marks.first()).toBeVisible();
    expect(errors, "page errors on the follower").toEqual([]);
  });
});
