import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { docLink, fakeRelay, ready, replaceSource, SHORT_DOC } from "./helpers";

/**
 * The map view's place in the app (decision 142, "Where" and "Budget"): a
 * third choice beside Edit and Document, in the pane the document view uses,
 * with `view=map` in the link, its code in a lazy chunk, and follow screens
 * unchanged. What the map draws inside its pane is step 2's later work; here
 * a frame is the section that names it.
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

test("a follow screen never offers or shows the map, even while the presenter is on it", async ({
  context,
}) => {
  // Row 142: follow screens are unchanged in this step.
  const { presenter, followUrl } = await openRoom(context);
  await presenter.getByRole("radio", { name: "Map" }).click();
  await expect(app(presenter)).toHaveAttribute("data-view", "map");
  const follower = await context.newPage();
  await ready(follower, followUrl);
  await expect(app(follower)).toHaveAttribute("data-view", "follow");
  await expect(follower.locator(".reveal .slides > section.present")).toBeVisible();
  await expect(follower.getByRole("radio", { name: "Map" })).toHaveCount(0);
  await expect(follower.locator("[data-map-frame]")).toHaveCount(0);
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
