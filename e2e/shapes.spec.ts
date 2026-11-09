import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { fakeRelay, ready, replaceSource } from "./helpers";

/**
 * Rectangle and ellipse tools (decision 110) across real pages. The shapes
 * travel as two corners in slide units, so a follower of another size must
 * draw the same box; the eraser has to reach them through drauu's index
 * (`getTotalLength` on <rect> and <ellipse>, which Chromium implements and
 * Firefox and WebKit must be checked for in CI).
 */

const DOC = ["# Shapes talk", "", "## One", "", "Alpha.", "", "## Two", "", "Beta.", ""].join("\n");

const DRAW = ".docwalk-annotate-draw[data-active='true']";

/** One drag across the presenter's overlay, corner to corner, as fractions of it. */
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const r = await page.locator(".docwalk-annotate").boundingBox();
  if (!r) throw new Error("annotation overlay missing");
  await page.mouse.move(r.x + r.width * from[0], r.y + r.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * to[0], r.y + r.height * to[1], { steps: 14 });
  await page.mouse.up();
}

/** Attributes of an element as numbers. */
async function numbers(el: Locator, names: string[]) {
  return el.evaluate((node, list) => list.map((name) => Number(node.getAttribute(name))), names);
}

/** The box of a shape as fractions of the slide: on the presenter in overlay pixels, on a follower in 1280 by 720 units. */
async function box(el: Locator, kind: "rect" | "ellipse", frame: { w: number; h: number }) {
  if (kind === "rect") {
    const [x, y, w, h] = await numbers(el, ["x", "y", "width", "height"]);
    return [x! / frame.w, y! / frame.h, w! / frame.w, h! / frame.h];
  }
  const [cx, cy, rx, ry] = await numbers(el, ["cx", "cy", "rx", "ry"]);
  return [cx! / frame.w, cy! / frame.h, rx! / frame.w, ry! / frame.h];
}

/** The overlay's own size in px. The deck scales the stage, so this is not its bounding box. */
async function overlaySize(page: Page) {
  return page.locator(".docwalk-annotate").evaluate((el) => ({
    w: (el as HTMLElement).offsetWidth,
    h: (el as HTMLElement).offsetHeight,
  }));
}

async function openPresenterRoom(context: BrowserContext) {
  const presenter = await context.newPage();
  await ready(presenter);
  await replaceSource(presenter, DOC);
  await expect(presenter.locator(".docwalk-outline-item")).toHaveCount(3);
  await presenter.getByRole("button", { name: "More actions" }).click();
  await presenter.getByRole("menuitem", { name: "Remote and followers…" }).click();
  const dialog = presenter.getByRole("dialog", { name: "Remote control" });
  await expect(dialog.getByText("Room open")).toBeVisible();
  const followUrl = await dialog.getByRole("textbox", { name: "Follow along link" }).inputValue();
  await dialog.getByRole("button", { name: "Close" }).click();
  await presenter.locator(".docwalk-outline-item").first().click();
  await expect(presenter.locator(".docwalk-preview-head strong")).toHaveText("1 / 3");
  return { presenter, followUrl };
}

test("a follower draws the presenter's rectangle and ellipse in the same box, and the eraser removes them on both", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  const follower = await context.newPage();
  await follower.setViewportSize({ width: 900, height: 600 });
  await ready(follower, followUrl);
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText("1 / 3");

  // Dragged bottom-right to top-left on purpose: the box is the same either way.
  await presenter.getByRole("radio", { name: "Rectangle" }).click();
  await drag(presenter, [0.6, 0.6], [0.2, 0.3]);
  await presenter.getByRole("radio", { name: "Ellipse" }).click();
  await drag(presenter, [0.65, 0.3], [0.9, 0.7]);

  const mine = {
    rect: presenter.locator(`${DRAW} rect`),
    ellipse: presenter.locator(`${DRAW} ellipse`),
  };
  const theirs = {
    rect: follower.locator(".docwalk-mirror rect[data-mark]"),
    ellipse: follower.locator(".docwalk-mirror ellipse[data-mark]"),
  };
  await expect(mine.rect).toHaveCount(1);
  await expect(theirs.rect).toHaveCount(1);
  await expect(theirs.ellipse).toHaveCount(1);

  const size = await overlaySize(presenter);
  const slide = { w: 1280, h: 720 };
  for (const kind of ["rect", "ellipse"] as const) {
    const expected = await box(mine[kind], kind, size);
    await expect
      .poll(async () => {
        const actual = await box(theirs[kind], kind, slide);
        return Math.max(...actual.map((n, i) => Math.abs(n - expected[i]!)));
      })
      .toBeLessThan(0.01);
  }

  // The eraser crosses the rectangle's top edge, clear of the ellipse.
  await presenter.getByRole("radio", { name: "Eraser" }).click();
  await drag(presenter, [0.4, 0.2], [0.4, 0.4]);
  await expect(mine.rect).toHaveCount(0);
  await expect(theirs.rect).toHaveCount(0);
  await expect(theirs.ellipse).toHaveCount(1);
  await expect(mine.ellipse).toHaveCount(1);
});

test("a drawn ellipse is saved and comes back after a reload", async ({ page }) => {
  await ready(page, "/#summary/1");
  await page.getByRole("radio", { name: "Ellipse" }).click();
  await drag(page, [0.2, 0.3], [0.6, 0.7]);
  await expect(page.locator(`${DRAW} ellipse`)).toHaveCount(1);
  const before = await box(page.locator(`${DRAW} ellipse`), "ellipse", await overlaySize(page));

  await page.reload();
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides?/, {
    timeout: 30_000,
  });
  const ellipse = page.locator(`${DRAW} ellipse`);
  await expect(ellipse).toHaveCount(1);
  const after = await box(ellipse, "ellipse", await overlaySize(page));
  after.forEach((n, i) => expect(Math.abs(n - before[i]!)).toBeLessThan(0.01));

  // The eraser reaches a restored shape, so a reload does not freeze marks in place.
  await page.getByRole("radio", { name: "Eraser" }).click();
  await drag(page, [0.4, 0.2], [0.4, 0.4]);
  await expect(ellipse).toHaveCount(0);
});

test("the toolbar with the two shape tools fits a 390 px wide phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page, "/#summary/1");
  // On a phone the deck is behind the Preview switch.
  await page.getByRole("radio", { name: "Preview" }).click();
  const rectangle = page.getByRole("radio", { name: "Rectangle" });
  await expect(rectangle).toBeVisible();
  const toolbar = await page.getByRole("toolbar", { name: "Annotate" }).boundingBox();
  expect(toolbar).not.toBeNull();
  expect(toolbar!.x + toolbar!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
