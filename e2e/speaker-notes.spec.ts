import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

/**
 * Speaker notes (decision 79): the HTML comments of a section, shown in the
 * presenter window beside the slide they belong to and nowhere else. These
 * tests run the assembled app: the audience window, a real presenter popup
 * and the document view.
 */

const OPENING = "Start with the outage story, then slow down.";
const CLOSING = "Thank the on-call team by name.";
const COVER = "Welcome the room before anything else.";
const DIRECTIVE = "markdownlint-disable MD033";
const HOSTILE =
  '<img src=x onerror="window.noteOwned = 1"> </section><script>window.noteOwned = 2</script>';
// A long note, to make the panel scroll.
const LONG = Array.from({ length: 40 }, (_, i) => `Talking point ${i + 1}.`).join("\n");

const DOC = [
  `<!-- ${DIRECTIVE} -->`,
  "",
  `<!-- ${COVER} -->`,
  "",
  "# Notes talk",
  "",
  "Welcome.",
  "",
  "## Opening",
  "",
  `<!-- ${OPENING} -->`,
  "",
  "Visible opening text.",
  "",
  "## Middle",
  "",
  "Visible middle text, no note.",
  "",
  "## Hostile",
  "",
  `<!-- ${HOSTILE} -->`,
  "",
  "Visible hostile text.",
  "",
  "## Long",
  "",
  `<!--\n${LONG}\n-->`,
  "",
  "Visible long text.",
  "",
  "## Closing",
  "",
  `<!-- ${CLOSING} -->`,
  "",
  "Visible closing text.",
  "",
].join("\n");

const NOTE_TEXTS = [OPENING, CLOSING, COVER, DIRECTIVE, "Talking point 1."];

async function openPresenter(page: Page, context: BrowserContext): Promise<Page> {
  const popup = context.waitForEvent("page");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popup;
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  return presenter;
}

/** Types the document and waits for the rebuilt deck: 6 sections plus the leading comment's slide. */
async function loadDoc(page: Page) {
  await ready(page);
  await replaceSource(page, DOC);
  await expect(page.getByRole("option", { name: /Closing/ })).toBeVisible({ timeout: 30_000 });
}

const notes = (presenter: Page) => presenter.locator(".docwalk-presenter-note");
const nowTitle = (presenter: Page) =>
  presenter.locator(".docwalk-presenter-current .docwalk-presenter-title");

test("the presenter window shows the current slide's note and changes it with the slide", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await loadDoc(page);
  await page.getByRole("option", { name: /Opening/ }).click();
  const presenter = await openPresenter(page, context);
  await expect(nowTitle(presenter)).toHaveText("Opening", { timeout: 30_000 });
  await expect(notes(presenter)).toHaveText([OPENING]);

  // A slide without a note says so, and the panel stays.
  await presenter.getByRole("button", { name: "Next slide" }).click();
  await expect(nowTitle(presenter)).toHaveText("Middle");
  await expect(notes(presenter)).toHaveCount(0);
  await expect(presenter.locator(".docwalk-presenter-notes")).toContainText(
    "No notes for this slide.",
  );

  // The note is text: the markup in it came out as characters and did nothing.
  await presenter.getByRole("button", { name: "Next slide" }).click();
  await expect(nowTitle(presenter)).toHaveText("Hostile");
  await expect(notes(presenter)).toHaveText([HOSTILE]);
  await expect(
    presenter.locator(".docwalk-presenter-notes img, .docwalk-presenter-notes script"),
  ).toHaveCount(0);
  expect(
    await presenter.evaluate(() => (window as { noteOwned?: number }).noteOwned),
  ).toBeUndefined();

  // Going back brings the first note back, and the cover shows the comment above it.
  await presenter.getByRole("option", { name: /Opening/ }).click();
  await expect(notes(presenter)).toHaveText([OPENING]);
  await presenter.getByRole("option", { name: /Notes talk/ }).click();
  await expect(nowTitle(presenter)).toHaveText("Notes talk");
  await expect(notes(presenter)).toHaveText([COVER]);
});

test("the audience deck and the document view never show a note, a directive or a comment", async ({
  page,
}) => {
  await loadDoc(page);
  const deck = await page.locator(".reveal").evaluate((el) => ({
    text: el.textContent ?? "",
    html: el.innerHTML,
  }));
  expect(deck.text).toContain("Visible opening text.");
  for (const hidden of NOTE_TEXTS) expect(deck.text).not.toContain(hidden);
  expect(deck.html).not.toContain("<!--");

  await page.getByRole("radio", { name: "Document" }).click();
  const pane = page.locator(".docwalk-document-pane");
  await expect(pane).toContainText("Visible opening text.");
  const doc = await pane.evaluate((el) => ({ text: el.textContent ?? "", html: el.innerHTML }));
  for (const hidden of NOTE_TEXTS) expect(doc.text).not.toContain(hidden);
  expect(doc.html).not.toContain("<!--");
  expect(await page.evaluate(() => (window as { noteOwned?: number }).noteOwned)).toBeUndefined();
});

test("a long note scrolls inside its panel and the slide keeps its size from slide to slide", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await loadDoc(page);
  await page.getByRole("option", { name: /Opening/ }).click();
  const presenter = await openPresenter(page, context);
  await expect(notes(presenter)).toHaveText([OPENING]);
  // The "Rendering previews" line above the stage takes room until the build is done.
  await expect(presenter.getByRole("status")).toBeEmpty({ timeout: 60_000 });
  const sizes = () =>
    presenter.evaluate(() => {
      // Runs in the page, so it cannot be moved out of this function.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const box = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      };
      return {
        panel: box(".docwalk-presenter-notes"),
        frame: box(".docwalk-presenter-current .docwalk-presenter-frame"),
      };
    });
  const short = await sizes();

  await presenter.getByRole("option", { name: /Long/ }).click();
  await expect(notes(presenter)).toContainText(["Talking point 40."]);
  const long = await sizes();
  expect(long).toEqual(short);
  const panel = presenter.locator(".docwalk-presenter-notes");
  expect(await panel.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // The page itself does not grow or scroll sideways.
  expect(
    await presenter.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
});

for (const scheme of ["light", "dark"] as const) {
  test(`on a narrow window in ${scheme} mode the notes stay readable and inside the page`, async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    await loadDoc(page);
    await page.getByRole("option", { name: /Opening/ }).click();
    const presenter = await openPresenter(page, context);
    await presenter.emulateMedia({ colorScheme: scheme });
    await presenter.setViewportSize({ width: 360, height: 700 });
    await expect(notes(presenter)).toHaveText([OPENING]);
    const note = notes(presenter);
    await note.scrollIntoViewIfNeeded();
    await expect(note).toBeInViewport();
    const fit = await presenter.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".docwalk-presenter-notes")!;
      const r = panel.getBoundingClientRect();
      const text = getComputedStyle(document.querySelector(".docwalk-presenter-note")!);
      // Runs in the page, so it cannot be moved out of this function.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const luminance = (css: string) => {
        const [red = 0, green = 0, blue = 0] = (css.match(/[\d.]+/g) ?? []).map(Number).map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      };
      const [a, b] = [luminance(text.color), luminance(getComputedStyle(panel).backgroundColor)];
      return {
        right: r.right,
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      };
    });
    expect(fit.right).toBeLessThanOrEqual(fit.width);
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.width);
    expect(fit.contrast).toBeGreaterThanOrEqual(4.5);
  });
}
