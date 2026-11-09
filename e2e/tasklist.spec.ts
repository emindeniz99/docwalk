import { readFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { tokens } from "../src/design/tokens";
import { ready, replaceSource } from "./helpers";

/**
 * GFM task list items (decision 86) in the built app, on every engine. Both
 * sanitizers remove `<input>`, so `- [x]` and `- [ ]` once rendered as plain
 * bullets with the state gone. The state is now drawn as a read-only mark
 * after sanitizing. Each view below receives the marks from the pages the app
 * actually built: slide, document, presenter preview and the three exports.
 */

const SHOTS = process.env["DOCWALK_SHOTS"];
const DONE = "Task done";
const OPEN = "Task not done";

const DOC = [
  "# Task talk",
  "",
  "Intro.",
  "",
  "## Plan",
  "",
  "- [x] Agree on the journal schema",
  "- [x] Prototype the outbox relay",
  "- [ ] Load-test 5,000 writes per second",
  "- [ ] Cut over everyone",
  "- a plain bullet",
  "",
  "## Hostile",
  "",
  '<input type="checkbox" checked disabled> author input',
  "",
  '<form action="https://attacker.invalid/"><input name="x"></form>',
  "",
  "- [ ] only this one is a task",
  "",
].join("\n");

const rgb = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
};
const present = (page: Page) => page.locator(".reveal .slides > section.present");

async function openDoc(page: Page) {
  await ready(page);
  await replaceSource(page, DOC);
  await expect(page.locator(".docwalk-statusbar")).toContainText(/(?<!\d)3 slides/);
  await expect(page.locator(".reveal .slides > section[data-docwalk-id='hostile']")).toHaveCount(1);
}

async function shot(target: Page | Locator, name: string) {
  if (SHOTS) await target.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** What a viewer sees of one mark: its box, whether it carries a tick, and where it sits. */
const look = (box: Locator) =>
  box.evaluate((el) => {
    const style = getComputedStyle(el);
    const tick = getComputedStyle(el, "::after");
    const item = el.closest("li") as HTMLElement;
    const text = item.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      border: style.borderTopColor,
      borderWidth: style.borderTopWidth,
      // A visible tick has content and a drawn bottom edge, in a colour of its own.
      tick:
        tick.content !== "none" &&
        tick.content !== "normal" &&
        parseFloat(tick.borderBottomWidth) > 0,
      tickColour: tick.borderBottomColor,
      listStyle: getComputedStyle(item).listStyleType,
      // The box hangs in the list gutter, left of the item's content box.
      left: rect.left - text.left,
    };
  });

test("slides draw a tick box for [x] and an empty box for [ ], named for a screen reader", async ({
  page,
}) => {
  await openDoc(page);
  await page.evaluate(() => {
    window.location.hash = "#plan";
  });
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  const slide = present(page);
  const done = slide.getByRole("img", { name: DONE });
  const open = slide.getByRole("img", { name: OPEN });
  await expect(done).toHaveCount(2);
  await expect(open).toHaveCount(2);
  // Each mark leads its own item, in the item's order.
  await expect(slide.locator("li.task-list-item")).toHaveCount(4);
  await expect(slide.locator("li.task-list-item").first()).toHaveText(
    "Agree on the journal schema",
  );
  await expect(slide.locator("li.task-list-item").first().getByRole("img")).toHaveAccessibleName(
    DONE,
  );
  await expect(slide.locator("li.task-list-item").nth(2).getByRole("img")).toHaveAccessibleName(
    OPEN,
  );
  // The page holds no form control: the marks are read-only drawings.
  await expect(slide.locator("input, form, button, [contenteditable]")).toHaveCount(0);

  const ticked = await look(done.first());
  const empty = await look(open.first());
  // State is a shape, not a colour: the done box has a tick, the open box has none.
  expect(ticked.tick).toBe(true);
  expect(empty.tick).toBe(false);
  expect(ticked.border).toBe(empty.border);
  expect(ticked.tickColour).toBe(rgb(tokens.colors["slide-ink"]));
  expect(empty.border).toBe(rgb(tokens.colors["slide-muted"]));
  for (const mark of [ticked, empty]) {
    expect(mark.width).toBeGreaterThanOrEqual(12);
    expect(mark.width).toBeLessThan(40);
    expect(mark.height).toBeCloseTo(mark.width, 0);
    // The list bullet is gone, so the box is not drawn beside a second marker.
    expect(mark.listStyle).toBe("none");
    expect(mark.left).toBeLessThan(0);
  }
  // Nothing spills sideways out of the slide body (rule 3, no hidden overflow).
  const body = slide.locator(".docwalk-slide-body").first();
  expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await shot(slide, "slide-plan");

  // A plain bullet in the same list keeps its bullet and gets no mark.
  const plain = slide.locator("li:not(.task-list-item)");
  await expect(plain).toHaveText("a plain bullet");
  await expect(plain.locator(".docwalk-task-box")).toHaveCount(0);
  expect(await plain.evaluate((el) => getComputedStyle(el).listStyleType)).not.toBe("none");
});

test("an input in the document is still removed, and only the Markdown task is marked", async ({
  page,
}) => {
  await openDoc(page);
  await page.evaluate(() => {
    window.location.hash = "#hostile";
  });
  await page.getByRole("button", { name: "Present" }).click();
  const slide = present(page);
  await expect(slide).toHaveAttribute("data-docwalk-id", "hostile");
  await expect(slide.getByRole("img", { name: OPEN })).toHaveCount(1);
  await expect(slide.getByRole("img", { name: DONE })).toHaveCount(0);
  await expect(slide.locator("input, form")).toHaveCount(0);
  await expect(slide).toContainText("author input");
});

test("document view shows the same marks, and they follow the dark theme", async ({ page }) => {
  await openDoc(page);
  await page.getByRole("radio", { name: "Document" }).click();
  const article = page.locator(".docwalk-document");
  await expect(article.getByRole("img", { name: DONE })).toHaveCount(2);
  await expect(article.getByRole("img", { name: OPEN })).toHaveCount(3);
  await expect(article.locator("input, form")).toHaveCount(0);
  const light = await look(article.getByRole("img", { name: OPEN }).first());
  expect(light.listStyle).toBe("none");
  expect(light.border).toBe(rgb(tokens.colors["ink-muted"]));
  await shot(article, "document-light");

  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await look(article.getByRole("img", { name: OPEN }).first());
  expect(dark.border).toBe(rgb(tokens.colors["ink-muted-dark"]));
  await shot(article, "document-dark");
});

test("the presenter window's slide previews show the marks", async ({ page, context }) => {
  test.setTimeout(90_000);
  await openDoc(page);
  await page.getByRole("option", { name: /Plan/ }).click();
  const popup = context.waitForEvent("page");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popup;
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  const current = presenter.locator(".docwalk-presenter-current");
  await expect(current.getByRole("img", { name: DONE })).toHaveCount(2, { timeout: 30_000 });
  await expect(current.getByRole("img", { name: OPEN })).toHaveCount(2);
  const ticked = await look(current.getByRole("img", { name: DONE }).first());
  expect(ticked.tick).toBe(true);
  expect(ticked.width).toBeGreaterThan(0);
  await shot(presenter, "presenter");
});

/** Downloads the HTML export and opens it with nothing from docwalk around it. */
async function openExport(page: Page, context: BrowserContext) {
  const trigger = page.getByRole("button", { name: "Export" });
  await expect(trigger).toBeEnabled();
  const download = page.waitForEvent("download");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download HTML" }).click();
  const html = await readFile(await (await download).path(), "utf8");
  const file = await context.newPage();
  await file.setContent(html);
  return { html, file };
}

test("the HTML export keeps both states, named, with its own stylesheet", async ({
  page,
  context,
}) => {
  await openDoc(page);
  const { html, file } = await openExport(page, context);
  expect(html).not.toMatch(/<script|<input|<form/i);
  const pageOf = file.locator(".docwalk-export-page", { hasText: "Agree on the journal schema" });
  await expect(pageOf.getByRole("img", { name: DONE })).toHaveCount(2);
  await expect(pageOf.getByRole("img", { name: OPEN })).toHaveCount(2);
  const ticked = await look(pageOf.getByRole("img", { name: DONE }).first());
  const empty = await look(pageOf.getByRole("img", { name: OPEN }).first());
  expect(ticked.tick).toBe(true);
  expect(ticked.tickColour).toBe(rgb(tokens.colors["slide-ink"]));
  expect(empty.tick).toBe(false);
  expect(empty.listStyle).toBe("none");
  expect(ticked.width).toBeGreaterThan(0);
  await shot(pageOf, "export-html");
});

test("print and PNG exports carry the marks", async ({ page }) => {
  await page.addInitScript(() => {
    window.print = () => undefined;
  });
  await openDoc(page);
  const trigger = page.getByRole("button", { name: "Export" });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await page.getByRole("menuitem", { name: "Print or save as PDF" }).click();
  const pages = page.frameLocator("iframe[data-docwalk-print]").locator(".docwalk-export-page");
  await expect(pages).toHaveCount(3);
  const printed = pages.filter({ hasText: "Agree on the journal schema" });
  await expect(printed.getByRole("img", { name: DONE })).toHaveCount(2);
  await expect(printed.getByRole("img", { name: OPEN })).toHaveCount(2);

  // PNG: the slide is mounted off-screen with the app's CSS, so the same marks must reach it.
  await expect(trigger).toBeEnabled();
  const names: string[] = [];
  page.on("download", async (file) => {
    names.push(file.suggestedFilename());
    if (SHOTS && /plan/.test(file.suggestedFilename()))
      await file.saveAs(`${SHOTS}/export-png.png`);
  });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Download PNG images" }).click();
  await expect.poll(() => names.length, { timeout: 30_000 }).toBe(3);
  expect(names.every((name) => name.endsWith(".png"))).toBe(true);
});

test("the palette finds a task's words, and the mark's name is not searchable text", async ({
  page,
}) => {
  await openDoc(page);
  await page.keyboard.press("Control+k");
  await page.keyboard.type("outbox");
  await expect(page.getByRole("option", { name: /Plan/ }).first()).toBeVisible();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Task not");
  await expect(page.getByText("In slide text")).toHaveCount(0);
});
