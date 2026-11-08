import { readFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

/**
 * Choosing which sections to present (decision 100). These tests run the
 * assembled app on the acceptance fixture (the default document), whose H2
 * sections include Summary, Goals and non-goals, Rollout and Security: the
 * choice is made in the dialog or read from the link, and every surface that
 * reads the deck has to agree with it.
 */

const sectionsButton = (page: Page) => page.getByRole("button", { name: /^Sections: / });
const picker = (page: Page) => page.getByRole("dialog", { name: "Choose sections to present" });
const outlineTitles = (page: Page) => page.locator(".docwalk-outline-title");
const unknownNote = (page: Page) =>
  page.getByText(/None of the chosen sections are in this document/);

/** Section ids the deck holds, once each, in order. */
const deckSections = (page: Page) =>
  page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll(".reveal .slides > section[data-docwalk-id]")].map((s) =>
        s.getAttribute("data-docwalk-id"),
      ),
    ),
  ]);

/** The slide count in the status bar, which is the deck's own count. */
async function slideCount(page: Page): Promise<number> {
  const text = (await page.locator(".docwalk-statusbar").textContent()) ?? "";
  return Number(/(\d+) slides/.exec(text)?.[1]);
}

const queryParam = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

/** Opens the dialog, clears it, checks the titles and applies. */
async function choose(page: Page, titles: string[]) {
  await sectionsButton(page).click();
  const dialog = picker(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Clear" }).click();
  for (const title of titles) await dialog.getByText(title, { exact: true }).click();
  await dialog.getByRole("button", { name: /^Show \d+ sections?$/ }).click();
  await expect(dialog).toBeHidden();
}

test("choosing two sections presents only those and keeps them in the link", async ({ page }) => {
  await ready(page);
  const total = await slideCount(page);
  await expect(sectionsButton(page)).toHaveText("Sections: all");

  await choose(page, ["Summary", "Rollout"]);

  await expect(outlineTitles(page)).toHaveText(["Summary", "Rollout"]);
  await expect(sectionsButton(page)).toHaveText(/^Sections: 2 of \d+$/);
  expect(await deckSections(page)).toEqual(["summary", "rollout"]);
  await expect.poll(() => queryParam(page, "sections")).toBe("summary,rollout");
  // The page counter and the status bar count the chosen slides, not the document's.
  const shown = await slideCount(page);
  expect(shown).toBeLessThan(total);
  await expect(page.locator(".docwalk-preview-head strong")).toHaveText(new RegExp(`/ ${shown}$`));
});

test("a reload keeps the selection, because it lives in the link", async ({ page }) => {
  await ready(page);
  await choose(page, ["Summary", "Rollout"]);
  await expect.poll(() => queryParam(page, "sections")).toBe("summary,rollout");
  await page.reload();
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides/, {
    timeout: 30_000,
  });
  await expect(outlineTitles(page)).toHaveText(["Summary", "Rollout"]);
  expect(await deckSections(page)).toEqual(["summary", "rollout"]);
  await expect(sectionsButton(page)).toHaveText(/^Sections: 2 of \d+$/);
});

test("a link with sections opens already filtered, and a skipped section's slide is nowhere in the deck", async ({
  page,
}) => {
  await ready(page, "/?sections=goals-and-non-goals,security");
  await expect(outlineTitles(page)).toHaveText(["Goals and non-goals", "Security"]);
  const ids = await deckSections(page);
  expect(ids).toEqual(["goals-and-non-goals", "security"]);
  expect(ids).not.toContain("summary");
});

test("a link to a skipped section opens the first chosen slide and rewrites the address", async ({
  page,
}) => {
  await ready(page, "/?sections=summary,rollout#security/1");
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#summary/1");
  await expect(page.locator(".reveal .slides > section.present")).toHaveAttribute(
    "data-docwalk-id",
    "summary",
  );
  // The selection in the link is untouched.
  expect(queryParam(page, "sections")).toBe("summary,rollout");
});

test("a link to a chosen section still opens exactly there", async ({ page }) => {
  await ready(page, "/?sections=summary,rollout#rollout/1");
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("#rollout/1");
  await expect(page.locator(".reveal .slides > section.present")).toHaveAttribute(
    "data-docwalk-id",
    "rollout",
  );
});

test("an id the document lacks is ignored without a word, beside ids it has", async ({ page }) => {
  await ready(page, "/?sections=summary,no-such-section");
  await expect(outlineTitles(page)).toHaveText(["Summary"]);
  await expect(unknownNote(page)).toHaveCount(0);
  await expect(sectionsButton(page)).toHaveText(/^Sections: 1 of \d+$/);
});

test("when none of the chosen ids exist every section is shown, and the page says so", async ({
  page,
}) => {
  await ready(page, "/?sections=nope,nada");
  const count = await outlineTitles(page).count();
  expect(count).toBeGreaterThan(5);
  await expect(unknownNote(page)).toBeVisible();
  await expect(unknownNote(page)).toContainText(`Showing all ${count}`);
  await expect(sectionsButton(page)).toHaveText("Sections: all");
});

test("a malformed list in the link is ignored, so the whole document shows", async ({ page }) => {
  await ready(page, "/?sections=summary,,rollout");
  expect(await outlineTitles(page).count()).toBeGreaterThan(5);
  await expect(sectionsButton(page)).toHaveText("Sections: all");
});

test("editing the document drops ids that vanish, falls back to everything when all vanish, and recovers", async ({
  page,
}) => {
  await ready(page, "/?sections=summary,rollout");
  await expect(outlineTitles(page)).toHaveText(["Summary", "Rollout"]);

  // Rollout is gone and Extra was never chosen: only Summary is left.
  await replaceSource(page, "# Talk\n\n## Summary\n\nStays.\n\n## Extra\n\nNot chosen.\n");
  await expect(outlineTitles(page)).toHaveText(["Summary"]);
  await expect(unknownNote(page)).toHaveCount(0);

  // Nothing chosen exists any more: the whole document, and a visible reason.
  await replaceSource(page, "# Talk\n\n## Fresh\n\nNew.\n\n## Other\n\nAlso new.\n");
  await expect(outlineTitles(page)).toHaveText(["Talk", "Fresh", "Other"]);
  await expect(unknownNote(page)).toContainText("Showing all 3");
  // The ids stay in the link while that lasts: a heading mid-edit passes through ids that do not exist.
  expect(queryParam(page, "sections")).toBe("summary,rollout");

  // Typing the heading back brings the selection back.
  await replaceSource(page, "# Talk\n\n## Summary\n\nBack.\n\n## Other\n\nx\n");
  await expect(outlineTitles(page)).toHaveText(["Summary"]);
  await expect(unknownNote(page)).toHaveCount(0);
});

test("opening another document clears the selection, even when it has a section of the same id", async ({
  page,
}) => {
  await ready(page, "/?sections=summary,rollout");
  await expect(outlineTitles(page)).toHaveText(["Summary", "Rollout"]);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open file" }).click();
  await (
    await chooser
  ).setFiles({
    name: "other.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Other\n\n## Summary\n\nSame id, another document.\n\n## Second\n\nx\n"),
  });
  await expect(outlineTitles(page)).toHaveText(["Other", "Summary", "Second"]);
  await expect(sectionsButton(page)).toHaveText("Sections: all");
  await expect.poll(() => queryParam(page, "sections")).toBeNull();
});

test("the dialog works from the keyboard: Space toggles, Apply waits for a section, Escape cancels", async ({
  page,
}) => {
  await ready(page);
  const button = sectionsButton(page);
  await button.focus();
  await page.keyboard.press("Enter");
  const dialog = picker(page);
  await expect(dialog).toBeVisible();
  // Everything starts checked: no selection yet.
  const boxes = dialog.getByRole("checkbox");
  const n = await boxes.count();
  expect(n).toBeGreaterThan(5);
  await expect(dialog.getByRole("group", { name: "Sections" })).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText(`${n} of ${n} sections checked`);

  const show = dialog.getByRole("button", { name: /^Show \d+ sections?$/ });
  await dialog.getByRole("button", { name: "Clear" }).click();
  for (let i = 0; i < n; i++) await expect(boxes.nth(i)).not.toBeChecked();
  await expect(dialog.getByRole("status")).toHaveText(`0 of ${n} sections checked`);
  // With nothing checked there is nothing to show, and the button says why.
  await expect(dialog.getByRole("button", { name: /^Show/ })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /^Show/ })).toHaveAccessibleDescription(
    "Check at least one section.",
  );

  const summary = dialog.getByRole("checkbox", { name: "Summary", exact: true });
  await summary.focus();
  await page.keyboard.press("Space");
  await expect(summary).toBeChecked();
  await expect(show).toBeEnabled();
  await expect(show).toHaveText("Show 1 section");
  await expect(dialog.getByRole("status")).toHaveText(`1 of ${n} sections checked`);

  // Escape closes without applying anything, and focus returns to where it was.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveText("Sections: all");
  expect(queryParam(page, "sections")).toBeNull();
});

test("Select all applies as no selection, so the link goes back to the plain one", async ({
  page,
}) => {
  await ready(page, "/?sections=summary");
  await sectionsButton(page).click();
  const dialog = picker(page);
  // The dialog starts from what is shown now.
  await expect(dialog.getByRole("checkbox", { name: "Summary", exact: true })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "Rollout", exact: true })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Select all" }).click();
  await dialog.getByRole("button", { name: /^Show \d+ sections$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(sectionsButton(page)).toHaveText("Sections: all");
  expect(await outlineTitles(page).count()).toBeGreaterThan(5);
  await expect.poll(() => queryParam(page, "sections")).toBeNull();
});

test("Cancel leaves the selection as it was", async ({ page }) => {
  await ready(page, "/?sections=summary,rollout");
  await sectionsButton(page).click();
  const dialog = picker(page);
  await dialog.getByRole("button", { name: "Clear" }).click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(outlineTitles(page)).toHaveText(["Summary", "Rollout"]);
  expect(queryParam(page, "sections")).toBe("summary,rollout");
});

test("the dialog opens from the command palette and from More actions", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("searchbox").fill("choose sections");
  await palette.getByRole("menuitem", { name: /Choose sections to present/ }).click();
  await expect(picker(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeHidden();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /Choose sections to present/ }).click();
  await expect(picker(page)).toBeVisible();
});

test("the palette lists only the chosen slides, and the overview shows only their pages", async ({
  page,
}) => {
  await ready(page, "/?sections=summary,rollout");
  const n = await slideCount(page);
  await expect(outlineTitles(page)).toHaveText(["Summary", "Rollout"]);

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  const slides = palette
    .locator(".docwalk-palette-section")
    .filter({ has: page.locator(".docwalk-overline", { hasText: /^Slides$/ }) })
    .getByRole("menuitem");
  await expect(slides).toHaveCount(n);
  await expect(slides.filter({ hasText: /Goals and non-goals/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.getByRole("button", { name: "Slide overview" }).click();
  const overview = page.getByRole("dialog", { name: "Slide overview" });
  await expect(overview).toBeVisible();
  await expect(overview.getByRole("row")).toHaveCount(n);
  await expect(overview.getByRole("row", { name: /Goals and non-goals/ })).toHaveCount(0);
});

test("the HTML export holds the chosen sections only", async ({ page }) => {
  await ready(page, "/?sections=summary,rollout");
  const n = await slideCount(page);
  const trigger = page.getByRole("button", { name: "Export" });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download HTML" }).click();
  const html = await readFile(await (await download).path(), "utf8");
  expect((html.match(/class="docwalk-export-page"/g) ?? []).length).toBe(n);
  expect(html).toContain("Rollout");
  expect(html).not.toContain("Goals and non-goals");
});

test("document mode still shows the whole file, whatever is chosen", async ({ page }) => {
  await ready(page, "/?sections=summary");
  await page.getByRole("radio", { name: "Document" }).click();
  await expect(page.locator(".docwalk-document-pane")).toContainText("Goals and non-goals");
  await expect(page.locator(".docwalk-document-pane")).toContainText("Rollout");
});

async function openPresenter(page: Page, context: BrowserContext): Promise<Page> {
  const popup = context.waitForEvent("page");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popup;
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  return presenter;
}

test("the presenter window lists the chosen slides only", async ({ page, context }) => {
  test.setTimeout(90_000);
  await ready(page, "/?sections=summary,rollout");
  const n = await slideCount(page);
  const presenter = await openPresenter(page, context);
  // Rollout spans two pages, so two options name it.
  await expect(presenter.getByRole("option", { name: /Rollout/ }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(presenter.getByRole("option")).toHaveCount(n);
  await expect(presenter.getByRole("option", { name: /Goals and non-goals/ })).toHaveCount(0);
});

test("a choice too long for a link says so in the dialog and is not written to the link", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await ready(page);
  // 22 headings of 200 letters each: without the cover, their ids are over 4,000 characters of link.
  const headings = Array.from({ length: 22 }, (_, i) => String.fromCharCode(97 + i).repeat(200));
  await replaceSource(page, `# Talk\n\n${headings.map((h) => `## ${h}\n\nBody.\n`).join("\n")}`);
  await expect(outlineTitles(page)).toHaveCount(23, { timeout: 30_000 });

  await sectionsButton(page).click();
  const dialog = picker(page);
  await dialog.getByText("Talk", { exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: "Talk", exact: true })).not.toBeChecked();
  const tooLong = dialog.getByText(/too long for a link/);
  await expect(tooLong).toBeVisible();
  await dialog.getByRole("button", { name: /^Show \d+ sections$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(outlineTitles(page)).toHaveCount(22);
  expect(queryParam(page, "sections")).toBeNull();
  // The choice works for this visit; the button still says so.
  await expect(sectionsButton(page)).toHaveText("Sections: 22 of 23");
});
