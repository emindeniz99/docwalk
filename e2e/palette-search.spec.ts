import { expect, test, type Page } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

/**
 * Full-text slide search in the command palette (decision 81). These tests
 * run the assembled app on the acceptance fixture: the palette reads the
 * paginated pages the audience sees, so a hit has to open the page that
 * holds the words.
 */

const hash = (page: Page) => page.evaluate(() => location.hash);
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
// React Aria wraps the "No match" text in a menuitem of its own; it is not a result.
const results = (page: Page) =>
  palette(page)
    .getByRole("menuitem")
    .filter({ hasNot: page.locator(".docwalk-palette-empty") });

async function openPalette(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  return palette(page).getByRole("searchbox");
}

test("a word that only a slide's body says finds that slide, with a snippet, and opens it", async ({
  page,
}) => {
  await ready(page, "/#rollout/1");
  const box = await openPalette(page);
  await box.fill("14:03 last Tuesday");
  await expect(results(page)).toHaveCount(1);
  // Under its own heading, with the match marked, so it is clear the words are in the text.
  await expect(palette(page).getByText("In slide text", { exact: true })).toBeVisible();
  await expect(results(page).first()).toContainText("Summary");
  await expect(results(page).first().locator("mark")).toHaveText("14:03 last Tuesday");
  await results(page).first().click();
  await expect(palette(page)).toBeHidden();
  await expect.poll(() => hash(page)).toBe("#summary/1");
});

test("a word on the second page of a split section opens that page, not the first", async ({
  page,
}) => {
  await ready(page, "/#summary/1");
  const box = await openPalette(page);
  // The last row of the configuration table: the section splits across pages.
  await box.fill("ledger.tracing.sample_rate");
  await expect(results(page)).toHaveCount(1);
  await results(page).first().click();
  await expect.poll(() => hash(page)).toMatch(/^#configuration-flags\/[2-9]$/);
  await expect(page.locator(".reveal .slides > section.present")).toContainText(
    "ledger.tracing.sample_rate",
  );
});

test("a title search works as it did: the Slides list, no text section, same destination", async ({
  page,
}) => {
  await ready(page, "/#summary/1");
  const box = await openPalette(page);
  await box.fill("rollout");
  await expect(results(page).first()).toBeVisible();
  await expect(palette(page).getByText("Slides", { exact: true })).toBeVisible();
  await results(page)
    .filter({ hasText: /^Rollout/ })
    .first()
    .click();
  await expect.poll(() => hash(page)).toBe("#rollout/1");
});

test("matching ignores case and accents like the title filter, and keyboard selection works", async ({
  page,
}) => {
  await ready(page, "/#rollout/1");
  const box = await openPalette(page);
  await box.fill("14:03 LAST TUESDAY");
  await expect(results(page)).toHaveCount(1);
  await box.fill("14:03 lást túesday");
  await expect(results(page)).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect.poll(() => hash(page)).toBe("#summary/1");
});

test("a query nothing matches says so, and one letter does not search the text", async ({
  page,
}) => {
  await ready(page);
  const box = await openPalette(page);
  await box.fill("qqzzxx");
  await expect(palette(page).getByText("No match")).toBeVisible();
  await box.fill("e");
  await expect(palette(page).getByText("In slide text", { exact: true })).toHaveCount(0);
});

test("a broad word lists at most ten text hits and says how many more", async ({ page }) => {
  await ready(page);
  const box = await openPalette(page);
  await box.fill("ledger");
  await expect(palette(page).getByText("In slide text", { exact: true })).toBeVisible();
  const textHits = palette(page)
    .locator(".docwalk-palette-section")
    .filter({ hasText: "In slide text" })
    .getByRole("menuitem");
  await expect(textHits).toHaveCount(10);
  await expect(palette(page).locator(".docwalk-palette-more")).toContainText(/\d+ more/);
});

const HOSTILE_DOC = [
  "# Hostile talk",
  "",
  "## Danger",
  "",
  'Look: `<img src=x onerror="window.paletteOwned = 1">` and `</section><script>window.paletteOwned = 2</script>`.',
  "",
  "```html",
  '<img src=x onerror="window.paletteOwned = 3">',
  "```",
  "",
  "<!-- secretlaunchdate is a speaker note -->",
  "",
  "## Calm",
  "",
  "Nothing to see.",
  "",
].join("\n");

test("page text that looks like markup is shown as characters and runs nothing", async ({
  page,
}) => {
  await ready(page);
  await replaceSource(page, HOSTILE_DOC);
  await expect(page.getByRole("option", { name: /Danger/ })).toBeVisible({ timeout: 30_000 });
  const box = await openPalette(page);
  await box.fill("onerror");
  await expect(results(page)).toHaveCount(1);
  const hit = results(page).first();
  await expect(hit).toContainText('<img src=x onerror="window.paletteOwned');
  await expect(hit.locator("mark")).toHaveText("onerror");
  await expect(palette(page).locator("img, script")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as { paletteOwned?: number }).paletteOwned),
  ).toBeUndefined();
  await hit.click();
  await expect.poll(() => hash(page)).toBe("#danger/1");
  expect(
    await page.evaluate(() => (window as { paletteOwned?: number }).paletteOwned),
  ).toBeUndefined();
});

test("a speaker note is not searchable: the palette is on the screen the room sees (decision 79)", async ({
  page,
}) => {
  await ready(page);
  await replaceSource(page, HOSTILE_DOC);
  await expect(page.getByRole("option", { name: /Danger/ })).toBeVisible({ timeout: 30_000 });
  const box = await openPalette(page);
  await box.fill("secretlaunchdate");
  await expect(palette(page).getByText("No match")).toBeVisible();
  await expect(results(page)).toHaveCount(0);
});

test("in document mode a text hit scrolls the reading view to the section and stays in Document", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("radio", { name: "Document" }).click();
  await expect(page.locator(".docwalk-document h2").first()).toBeVisible();
  const box = await openPalette(page);
  await box.fill("Extend shadow writes to all traffic");
  await expect(results(page).first()).toBeVisible();
  await results(page).first().click();
  await expect(palette(page)).toBeHidden();
  await expect(page.getByRole("radio", { name: "Document" })).toBeChecked();
  const heading = page.locator(".docwalk-document h2", { hasText: "Rollout" });
  await expect(heading).toBeInViewport();
});

test("in the Turkish UI the section is named in Turkish and a capital I finds dotless ı", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("docwalk.locale", "tr"));
  await page.goto("/");
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slayt/, { timeout: 30_000 });
  await replaceSource(page, "# Deneme\n\n## Bir\n\nIşık ve sıra burada, İstanbul da.\n");
  await expect(page.getByRole("option", { name: /Bir/ })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Komut paleti" });
  await expect(dialog).toBeVisible();
  const box = dialog.getByRole("searchbox");
  await box.fill("SIRA");
  await expect(dialog.getByText("Slayt metninde", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("menuitem")).toHaveCount(1);
  await expect(dialog.locator("mark")).toHaveText("sıra");
  await box.fill("istanbul");
  await expect(dialog.locator("mark")).toHaveText("İstanbul");
});

test.describe("typing in a large document", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "frame gaps are measured on Chromium");

  test("typing a long query into the 809-line fixture never blocks a frame for long", async ({
    page,
  }) => {
    // The palette scans every page's text on each key. A frame that waits
    // this long would show as a stutter while typing.
    const FRAME_LIMIT_MS = 250;
    await ready(page);
    const box = await openPalette(page);
    await page.evaluate(() => {
      const w = window as unknown as { frameGap: number };
      w.frameGap = 0;
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        w.frameGap = Math.max(w.frameGap, now - last);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await box.pressSequentially("clients retry with the same idempotency key", { delay: 20 });
    await expect(palette(page).locator("mark").first()).toBeVisible();
    const gap = await page.evaluate(() => (window as unknown as { frameGap: number }).frameGap);
    console.log(
      `longest frame gap while typing: ${Math.round(gap)} ms (limit ${FRAME_LIMIT_MS} ms)`,
    );
    expect(gap).toBeLessThan(FRAME_LIMIT_MS);
  });
});
