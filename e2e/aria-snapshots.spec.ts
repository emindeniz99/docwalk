import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ready, replaceSource, SHORT_DOC } from "./helpers";

/**
 * ARIA snapshots of the main views (decision 39, narrowed by 85). axe finds
 * rule violations (a11y.spec.ts); these pin what a screen reader is told: which
 * landmarks, names and roles each view exposes, so a refactor that drops a
 * label, a landmark or a heading level fails here with a readable diff.
 *
 * The templates are inline text, which is the same on every OS, so there are
 * no baseline files to keep per platform (a screenshot would need one per
 * engine and OS, and none can be made here: decision 85). Playwright matches a
 * template as a subsequence, so each one names what the three engines agree
 * on and leaves out what they do not:
 * - the shortcut hint in the palette button reads "Ctrl+K" on Chromium and
 *   Firefox and "K" on WebKit, whose Desktop Safari profile counts as a Mac
 *   and draws the command glyph as an aria-hidden icon (src/shell/ModShortcut.tsx);
 * - the Files panel and the workspace commands are missing on WebKit, which
 *   refuses the origin private file system in a throwaway context;
 * - "Open local folder…" exists only where the File System Access API does
 *   (Chromium).
 * The document is the short one from helpers, so the trees stay small and the
 * numbers in them are the document's, not a fixture's.
 */

/** Opens the short document in the edit view, on its last slide. */
async function openShort(page: Page) {
  await ready(page);
  await replaceSource(page, SHORT_DOC);
  await expect(page.locator(".docwalk-statusbar")).toContainText("3 slides");
}

test("edit view: header, outline, source and stage have names and roles", async ({ page }) => {
  await openShort(page);
  await expect(page.getByRole("banner")).toMatchAriaSnapshot(`
    - banner:
      - img "docwalk"
      - strong: Round trip
      - button /Jump to slide or command…/
      - radiogroup "View":
        - radio "Edit" [checked]
        - radio "Document"
      - button "Open file"
      - button "Share"
      - button "Export"
      - button "Comments"
      - button "More actions"
      - button /Theme/
      - button "Present"
  `);
  await expect(page.getByRole("main")).toMatchAriaSnapshot(`
    - main:
      - complementary:
        - navigation "Outline":
          - listbox "Sections":
            - option "Round trip 1"
            - option "First point 1"
            - option "Second point 1" [selected]
      - region "Markdown source":
        - textbox "Markdown source"
      - button "Slide overview"
      - toolbar "Annotate":
        - radiogroup "Tool":
          - radio "Pen"
          - radio "Laser pointer"
          - radio "Arrow"
          - radio "Eraser"
        - radiogroup "Pen colour":
          - radio "Vermilion" [checked]
          - radio "Blue"
          - radio "Ink"
        - button "Undo mark"
        - button "Clear marks"
      - application "Slides":
        - navigation "Section path": Round trip
        - heading "Second point" [level=2]
        - paragraph: Beta.
  `);
  await expect(page.getByRole("contentinfo", { name: "Status" })).toMatchAriaSnapshot(`
    - contentinfo "Status": /3 slides.*0 notes.*0 diagram errors/
  `);
});

test("document view: the page reads as one article with the headings in order", async ({
  page,
}) => {
  await openShort(page);
  await page.getByRole("radio", { name: "Document" }).click();
  await expect(page.locator(".docwalk-document")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "View" })).toMatchAriaSnapshot(`
    - radiogroup "View":
      - radio "Edit"
      - radio "Document" [checked]
  `);
  await expect(page.getByRole("main")).toMatchAriaSnapshot(`
    - main:
      - region "Document":
        - article "Document":
          - heading "Round trip" [level=1]
          - heading "First point" [level=2]
          - paragraph: Alpha.
          - heading "Second point" [level=2]
          - paragraph: Beta.
  `);
});

test("present view: the stage, its tools and the way out have names", async ({ page }) => {
  await openShort(page);
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  await expect(page.getByRole("main")).toMatchAriaSnapshot(`
    - main:
      - strong: 3 / 3
      - button "Slide overview"
      - button /Exit/
      - toolbar "Annotate":
        - radiogroup "Tool":
          - radio "Pen"
          - radio "Laser pointer"
        - button "Undo mark"
        - button "Clear marks"
      - application "Slides":
        - navigation "Section path": Round trip
        - heading "Second point" [level=2]
        - paragraph: Beta.
        - complementary:
          - button "Previous slide"
  `);
});

test("slide overview: a dialog with one named row per slide, marking the current one", async ({
  page,
}) => {
  await openShort(page);
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  await page.getByRole("button", { name: "Slide overview" }).click();
  await expect(page.getByRole("dialog", { name: "Slide overview" })).toMatchAriaSnapshot(`
    - dialog "Slide overview":
      - banner:
        - heading "Slide overview" [level=2]
        - text: 3 slides
        - button "Close overview"
      - grid "Slides":
        - row "Round trip, slide 1 of 3":
          - gridcell "1 Round trip"
        - row "First point, slide 2 of 3":
          - gridcell "2 First point"
        - row "Second point, slide 3 of 3, current slide":
          - gridcell "3 Second point Current"
  `);
});

test("command palette: a dialog with a search box, commands and every slide", async ({ page }) => {
  await openShort(page);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toMatchAriaSnapshot(`
    - dialog "Command palette":
      - searchbox "Jump to a slide or run a command"
      - menu "Suggestions":
        - group "Commands":
          - menuitem "Present"
          - menuitem "Open presenter view"
          - menuitem /Slide overview/
          - menuitem "Show editor"
          - menuitem "Show document"
          - menuitem "Share link"
          - menuitem "Show comments"
          - menuitem "GitHub token…"
        - group "Slides":
          - menuitem "Round trip 1"
          - menuitem "First point 2"
          - menuitem "Second point 3"
  `);
});

test("share dialog: a titled dialog whose link field and copy button have names", async ({
  page,
}) => {
  await openShort(page);
  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByRole("dialog", { name: "Share this document" })).toMatchAriaSnapshot(`
    - dialog "Share this document":
      - heading "Share this document" [level=2]
      - button "Close"
      - textbox "Link": /.*#doc=.+/
      - button "Copy link"
      - paragraph: /The document is inside the link.*/
  `);
});

test("token dialog: the field is labelled and the links say where they go", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "GitHub token…" }).click();
  await expect(page.getByRole("dialog", { name: "GitHub access token" })).toMatchAriaSnapshot(`
    - dialog "GitHub access token":
      - heading "GitHub access token" [level=2]
      - link "Create a token on GitHub":
        - /url: https://github.com/settings/personal-access-tokens/new
      - textbox "Fine-grained token"
      - button "Save token"
      - button "Forget token" [disabled]
      - button "Close"
      - link "Review or revoke your tokens on GitHub":
        - /url: https://github.com/settings/personal-access-tokens
  `);
});

/** Opens the presenter window from the palette and waits until its previews are built. */
async function openPresenter(page: Page, context: BrowserContext) {
  const popup = context.waitForEvent("page");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popup;
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(presenter.getByRole("status")).toBeEmpty({ timeout: 60_000 });
  return presenter;
}

test("presenter window: timer, notes, the current slide and the slide list have names", async ({
  page,
  context,
}) => {
  // The window renders the deck a second time as previews; see a11y.spec.ts
  // for why the default 60 s is too tight for WebKit on a busy runner.
  test.setTimeout(90_000);
  await openShort(page);
  const presenter = await openPresenter(page, context);
  // The wall clock ("time") is left out of the template on purpose.
  await expect(presenter.getByRole("banner")).toMatchAriaSnapshot(`
    - banner:
      - timer "Elapsed time": /\\d+:\\d\\d/
      - textbox "Target (minutes)"
      - button "Start"
      - button "Previous slide"
      - button "Next slide" [disabled]
  `);
  await expect(presenter.getByRole("main")).toMatchAriaSnapshot(`
    - main:
      - figure "Now Second point":
        - navigation "Section path": Round trip
        - heading "Second point" [level=2]
        - paragraph: Beta.
      - region "Speaker notes":
        - paragraph: No notes for this slide.
      - complementary:
        - figure "Next End of the deck"
        - listbox "Slides":
          - option "1 Round trip"
          - option "2 First point"
          - option "3 Second point" [selected]
  `);
});
