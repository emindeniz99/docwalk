import { readFileSync } from "node:fs";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { fakeRelay, ready, replaceSource } from "./helpers";

/**
 * Mirroring the code, table and image focus views and their line marks
 * (decision 106) across real pages, with the relay played by `fakeRelay` as
 * in mirror.spec.ts. The follower is smaller than the presenter on purpose:
 * zoom travels as a share of each screen's own Fit and scroll as a share of
 * how far each can scroll, so the numbers differ and the framing matches.
 */

const SHOTS = process.env["DOCWALK_SHOTS"];
const REMOTE = "https://images.invalid/chart.png";
// The app's own icon, so the stubbed remote image has a real size.
const PNG = readFileSync(new URL("../public/icons/icon-192.png", import.meta.url));

const cell = (i: number) => `${"w".repeat(11)}${i % 10}`;
const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
const HEAD = Array.from({ length: 16 }, (_, i) => cell(i));

const DOC = [
  "# Focus talk",
  "",
  "## Code",
  "",
  "```ts",
  "export function retry(attempt: number): number {",
  "  const base = 200;",
  "",
  "  return base * 2 ** attempt;",
  "}",
  "```",
  "",
  "## Table",
  "",
  // One body row: pagination gives each row of a table this wide a page of its own.
  row(HEAD),
  row(HEAD.map(() => "---")),
  row(HEAD),
  "",
  "## Logo",
  "",
  "![Company logo](/icons/icon-192.png)",
  "",
  "## Chart",
  "",
  `![Chart](${REMOTE})`,
  "",
  "```text",
  "after the chart",
  "```",
  "",
].join("\n");
const SLIDES = 5;

const view = (page: Page) => page.locator(".docwalk-focus");
const present = (page: Page) => page.locator(".reveal .slides > section.present");
const lines = (page: Page) => view(page).locator(".docwalk-code-line");

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The type size of an open code or table view (`--focus-scale`). */
const typeScale = (page: Page) =>
  view(page)
    .locator(".docwalk-focus-sheet")
    .evaluate((sheet) => Number((sheet as HTMLElement).style.getPropertyValue("--focus-scale")));

/** How far the open text view is scrolled across, as a share of how far it can scroll. */
const scrolledAcross = (page: Page) =>
  view(page)
    .locator(".docwalk-focus-stage")
    .evaluate((stage) => stage.scrollLeft / Math.max(1, stage.scrollWidth - stage.clientWidth));

/** The scale Panzoom gives a canvas view. */
async function canvasScale(page: Page) {
  const style = (await view(page).locator(".docwalk-focus-canvas").getAttribute("style")) ?? "";
  return Number(/scale\(([\d.]+)\)/.exec(style)?.[1] ?? "1");
}

/** Which code lines of the open view are marked, from 1. */
const marked = (page: Page) =>
  lines(page).evaluateAll((all) =>
    all.flatMap((line, i) => (line.getAttribute("aria-pressed") === "true" ? [i + 1] : [])),
  );

async function openPresenterRoom(context: BrowserContext) {
  const presenter = await context.newPage();
  await ready(presenter);
  await replaceSource(presenter, DOC);
  await expect(presenter.locator(".docwalk-outline-item")).toHaveCount(SLIDES);
  await presenter.getByRole("button", { name: "More actions" }).click();
  await presenter.getByRole("menuitem", { name: "Remote and followers…" }).click();
  const dialog = presenter.getByRole("dialog", { name: "Remote control" });
  await expect(dialog.getByText("Room open")).toBeVisible();
  const followUrl = await dialog.getByRole("textbox", { name: "Follow along link" }).inputValue();
  await dialog.getByRole("button", { name: "Close" }).click();
  return { presenter, followUrl };
}

async function openFollower(
  context: BrowserContext,
  url: string,
  options: {
    size?: { width: number; height: number };
    before?: (page: Page) => Promise<void>;
  } = {},
) {
  const follower = await context.newPage();
  await follower.setViewportSize(options.size ?? { width: 900, height: 600 });
  await options.before?.(follower);
  await ready(follower, url);
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText(
    new RegExp(`/ ${SLIDES}$`),
  );
  return follower;
}

/** Moves the presenter to the slide titled `title` and waits for the follower to get there. */
async function goTo(presenter: Page, follower: Page, title: string, at: number) {
  await presenter.getByRole("option", { name: new RegExp(title) }).click();
  await expect(presenter.locator(".docwalk-preview-head strong")).toHaveText(`${at} / ${SLIDES}`);
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText(`${at} / ${SLIDES}`);
}

async function openBlock(page: Page, block: Locator, kind: string) {
  await block.click();
  await expect(view(page)).toHaveAttribute("data-kind", kind);
}

test("a follower opens the presenter's code view with two marked lines, follows its zoom and closes with it", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  const follower = await openFollower(context, followUrl);
  await goTo(presenter, follower, "Code", 2);

  await openBlock(presenter, present(presenter).locator("pre"), "code");
  await expect(view(follower)).toHaveAttribute("data-kind", "code");
  await expect(lines(follower)).toHaveCount(5);
  const presenterFit = await typeScale(presenter);
  const followerFit = await typeScale(follower);

  await lines(presenter).nth(0).click();
  await lines(presenter).nth(3).click();
  await expect.poll(() => marked(follower)).toEqual([1, 4]);

  // Zoom travels as a share of Fit: each screen zooms from its own.
  await presenter.getByRole("button", { name: "Zoom in" }).click();
  await presenter.getByRole("button", { name: "Zoom in" }).click();
  const ratio = (await typeScale(presenter)) / presenterFit;
  expect(ratio).toBeGreaterThan(1.1);
  await expect
    .poll(async () => Math.abs((await typeScale(follower)) / followerFit - ratio))
    .toBeLessThan(0.01);
  await shot(follower, "follower-code-marked");

  // Clear on the presenter clears the follower's marks too.
  await presenter.getByRole("button", { name: "Clear all marked lines" }).click();
  await expect.poll(() => marked(follower)).toEqual([]);
  await view(presenter).getByRole("button", { name: "Close" }).click();
  await expect(view(presenter)).toHaveCount(0);
  await expect(view(follower)).toHaveCount(0);
});

test("a follower's table view scrolls with the presenter's, as a share of how far each can scroll", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  const follower = await openFollower(context, followUrl);
  await goTo(presenter, follower, "Table", 3);

  await openBlock(presenter, present(presenter).locator("table"), "table");
  await expect(view(follower)).toHaveAttribute("data-kind", "table");
  const stage = view(presenter).locator(".docwalk-focus-stage");
  const reach = await stage.evaluate((s) => s.scrollWidth - s.clientWidth);
  expect(reach, "the presenter's table scrolls sideways").toBeGreaterThan(200);

  // A plain wheel scrolls the text views natively; Ctrl or Cmd would zoom.
  await stage.hover();
  await presenter.mouse.wheel(reach * 0.6, 0);
  await expect.poll(() => scrolledAcross(presenter)).toBeGreaterThan(0.3);
  const across = await scrolledAcross(presenter);
  await expect
    .poll(async () => Math.abs((await scrolledAcross(follower)) - across))
    .toBeLessThan(0.02);
  await shot(follower, "follower-table-scrolled");

  await presenter.keyboard.press("Escape");
  await expect(view(follower)).toHaveCount(0);
});

test("a follower opens the presenter's image view on its own loaded copy and follows its zoom", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  const follower = await openFollower(context, followUrl);
  await goTo(presenter, follower, "Logo", 4);

  await openBlock(presenter, present(presenter).locator("img"), "image");
  await expect(view(follower)).toHaveAttribute("data-kind", "image");
  await expect(view(follower).locator("img")).toHaveJSProperty("complete", true);
  await expect(view(follower).locator("img")).toHaveAttribute("alt", "Company logo");

  await presenter.getByRole("button", { name: "Zoom in" }).click();
  await presenter.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(() => canvasScale(presenter)).toBeGreaterThan(1.3);
  await expect.poll(() => canvasScale(follower)).toBeGreaterThan(1.3);
  await shot(follower, "follower-image");

  await presenter.keyboard.press("Escape");
  await expect(view(follower)).toHaveCount(0);
});

test("an image the follower has not loaded stays blocked and unrequested when the presenter opens it", async ({
  context,
}) => {
  // Decision 33 is the gate, and mirroring is not a way past it (decision 106):
  // the presenter loads the remote image, the follower never asks for it.
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  await presenter.route(REMOTE, (route) => route.fulfill({ body: PNG, contentType: "image/png" }));
  const asked: string[] = [];
  const errors: string[] = [];
  const follower = await openFollower(context, followUrl, {
    before: async (page) => {
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("https://images.invalid/**", (route) => {
        asked.push(route.request().url());
        return route.abort();
      });
    },
  });
  await goTo(presenter, follower, "Chart", 5);

  const chart = present(presenter).locator("img");
  await chart.click();
  await expect(chart).toHaveAttribute("data-docwalk-focus", "image");
  await openBlock(presenter, chart, "image");
  await presenter.getByRole("button", { name: "Zoom in" }).click();

  // The code view on the same slide shows the ops arrived, and in order.
  await presenter.keyboard.press("Escape");
  await openBlock(presenter, present(presenter).locator("pre"), "code");
  await expect(view(follower)).toHaveAttribute("data-kind", "code");
  const theirs = present(follower).locator("img");
  await expect(theirs).toHaveClass(/docwalk-blocked-image/);
  expect(await theirs.getAttribute("src")).toBeNull();
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
  await shot(follower, "follower-image-blocked");
});

test("a follower that joins late gets the open code view, its zoom and its marked lines", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  await presenter.getByRole("option", { name: /Code/ }).click();
  await expect(presenter.locator(".docwalk-preview-head strong")).toHaveText(`2 / ${SLIDES}`);
  await openBlock(presenter, present(presenter).locator("pre"), "code");
  const presenterFit = await typeScale(presenter);
  await lines(presenter).nth(1).click();
  await lines(presenter).nth(4).click();
  await presenter.getByRole("button", { name: "Zoom in" }).click();
  const ratio = (await typeScale(presenter)) / presenterFit;

  // The presenter's page is inert behind its view; the room answers the newcomer all the same.
  const late = await openFollower(context, followUrl, { size: { width: 700, height: 500 } });
  await expect(late.locator(".docwalk-preview-head strong")).toHaveText(`2 / ${SLIDES}`);
  await expect(view(late)).toHaveAttribute("data-kind", "code");
  // The marks come last in a resync, so the zoom before them has arrived too.
  await expect.poll(() => marked(late)).toEqual([2, 5]);
  const zoomed = await typeScale(late);
  await shot(late, "late-follower-code");

  // Its zoom is the presenter's share of Fit, on this screen's own Fit.
  await late.getByRole("button", { name: "Fit to screen" }).click();
  const fit = await typeScale(late);
  expect(Math.abs(zoomed / fit - ratio)).toBeLessThan(0.01);
});
