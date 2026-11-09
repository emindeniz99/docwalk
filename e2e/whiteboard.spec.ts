import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { fakeRelay, ready, replaceSource } from "./helpers";

/**
 * The whiteboard (decision 110) across real pages: the presenter's tab, a
 * follower and the presenter window. The layer, the mirror and the saved
 * marks have their own tests; only here do the toggle, the keys, the
 * relay, BroadcastChannel and a reload meet.
 */

const DOC = [
  "# Board talk",
  "",
  "## One",
  "",
  "Alpha text.",
  "",
  "## Two",
  "",
  "Beta text.",
  "",
].join("\n");

const ACTIVE_MARKS = ".docwalk-annotate-draw[data-active='true'] > *";
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** One pen stroke across the presenter's overlay, as fractions of it. */
async function stroke(page: Page, from: [number, number], to: [number, number]) {
  const r = await page.locator(".docwalk-annotate").boundingBox();
  if (!r) throw new Error("annotation overlay missing");
  await page.mouse.move(r.x + r.width * from[0], r.y + r.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * to[0], r.y + r.height * to[1], { steps: 14 });
  await page.mouse.up();
}

/** What sits at the middle of the slide box: the page, the board over it, or nothing. */
async function topmost(page: Page): Promise<"page" | "board" | "nothing"> {
  return page.locator(".docwalk-annotate").evaluate((overlay) => {
    const r = overlay.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!hit) return "nothing";
    return hit.closest(".docwalk-annotate") ? "board" : hit.closest(".slides") ? "page" : "nothing";
  });
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
  await presenter.locator(".docwalk-outline-item").nth(1).click();
  await expect(presenter.locator(".docwalk-preview-head strong")).toHaveText("2 / 3");
  return { presenter, followUrl };
}

async function openPresenterWindow(context: BrowserContext, presenter: Page) {
  const popup = context.waitForEvent("page");
  await presenter.keyboard.press("Control+k");
  await presenter.keyboard.type("presenter");
  await presenter.getByRole("menuitem", { name: "Open presenter view" }).click();
  const window = await popup;
  await window.setViewportSize({ width: 1280, height: 800 });
  await expect(window.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  return window;
}

const board = (page: Page) => page.locator(".docwalk-annotate[data-board]");
const mirrorBoard = (scope: Page | Locator) => scope.locator(".docwalk-mirror[data-board]");
const mirrorMarks = (scope: Page | Locator) => scope.locator(".docwalk-mirror [data-mark]");

test("W opens a blank board on the presenter, a follower and the presenter window; a slide change closes all three", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  const follower = await context.newPage();
  await follower.setViewportSize({ width: 900, height: 600 });
  await ready(follower, followUrl);
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText("2 / 3");
  const window = await openPresenterWindow(context, presenter);
  const current = window.locator(".docwalk-presenter-current");
  const next = window.locator(".docwalk-presenter-next");

  // A mark on the slide first, to find it again after the board.
  await presenter.getByRole("radio", { name: "Pen" }).click();
  await stroke(presenter, [0.2, 0.3], [0.6, 0.35]);
  await presenter.getByRole("radio", { name: "Pen" }).click();
  await expect(mirrorMarks(follower)).toHaveCount(1);
  await expect(mirrorMarks(current)).toHaveCount(1);
  await expect.poll(() => topmost(presenter)).toBe("page");

  await presenter.locator(".reveal").focus();
  await presenter.keyboard.press("w");
  await expect(board(presenter)).toHaveCount(1);
  await expect.poll(() => topmost(presenter)).toBe("board");
  await expect(presenter.getByRole("status").filter({ hasText: "Whiteboard open" })).toHaveText(
    "Whiteboard open: One",
  );
  await expect(presenter.getByRole("button", { name: "Whiteboard" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The pen was chosen for the viewer, so the first touch draws.
  await expect(presenter.getByRole("radio", { name: "Pen" })).toBeChecked();
  await expect(mirrorBoard(follower)).toHaveCount(1);
  await expect(mirrorBoard(current)).toHaveCount(1);
  await expect(mirrorBoard(next)).toHaveCount(0);
  // The slide's own mark is hidden on every screen while the board shows.
  await expect(mirrorMarks(follower)).toHaveCount(0);
  await expect(mirrorMarks(current)).toHaveCount(0);

  await stroke(presenter, [0.3, 0.6], [0.7, 0.7]);
  await expect(presenter.locator(ACTIVE_MARKS)).toHaveCount(1);
  await expect(mirrorMarks(follower)).toHaveCount(1);
  await expect(mirrorMarks(current)).toHaveCount(1);

  // A clicker brings the room back to the deck, on all three screens.
  await presenter.keyboard.press("ArrowRight");
  await expect(board(presenter)).toHaveCount(0);
  await expect(presenter.getByRole("status").filter({ hasText: "Whiteboard closed" })).toHaveCount(
    1,
  );
  await expect(mirrorBoard(follower)).toHaveCount(0);
  await expect(mirrorBoard(current)).toHaveCount(0);
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText("3 / 3");

  // Back on the slide its mark is intact, and the board keeps its own stroke.
  await presenter.keyboard.press("ArrowLeft");
  await expect(presenter.locator(".docwalk-preview-head strong")).toHaveText("2 / 3");
  await expect(presenter.locator(ACTIVE_MARKS)).toHaveCount(1);
  await expect(mirrorMarks(follower)).toHaveCount(1);
  await presenter.keyboard.press("w");
  await expect(board(presenter)).toHaveCount(1);
  await expect(presenter.locator(ACTIVE_MARKS)).toHaveCount(1);
  await expect(mirrorBoard(follower)).toHaveCount(1);
  await expect(mirrorMarks(follower)).toHaveCount(1);
  await presenter.keyboard.press("w");
  await expect(board(presenter)).toHaveCount(0);
});

test("a board's stroke is saved with the document and comes back after a reload", async ({
  page,
}) => {
  await ready(page, "/#summary/1");
  await page.locator(".reveal").focus();
  await page.keyboard.press("w");
  await expect(board(page)).toHaveCount(1);
  await stroke(page, [0.3, 0.6], [0.7, 0.6]);
  await expect(page.locator(ACTIVE_MARKS)).toHaveCount(1);

  await page.reload();
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides?/, {
    timeout: 30_000,
  });
  // The slide is clean and the board has its stroke.
  await expect(page.locator(ACTIVE_MARKS)).toHaveCount(0);
  await page.locator(".reveal").focus();
  await page.keyboard.press("w");
  await expect(board(page)).toHaveCount(1);
  await expect(page.locator(ACTIVE_MARKS)).toHaveCount(1);
});

test("Escape turns the pen off, then closes the board, then leaves the talk", async ({
  page,
  browserName,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  await page.locator(".reveal").focus();
  await page.keyboard.press("w");
  await expect(board(page)).toHaveCount(1);
  await expect(page.getByRole("radio", { name: "Pen" })).toBeChecked();

  // Firefox and WebKit really enter fullscreen and keep Escape for leaving it
  // (decision 110): the page never sees that first key, so the board stays open
  // with the pen still on and presenting goes on windowed. Chromium delivers
  // the key to the page, so its first Escape already turns the pen off.
  const inFullscreen = () => page.evaluate(() => document.fullscreenElement !== null);
  if (browserName === "firefox" || browserName === "webkit") {
    await expect.poll(inFullscreen).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(inFullscreen).toBe(false);
    await expect(board(page)).toHaveCount(1);
    await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
    await expect(page.getByRole("radio", { name: "Pen" })).toBeChecked();
  }

  // Windowed from here on, on every engine.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("radio", { name: "Pen" })).not.toBeChecked();
  await expect(board(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(board(page)).toHaveCount(0);
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
  await page.keyboard.press("Escape");
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "edit");
});

test("the page under an open board is out of the keyboard's reach and axe finds nothing", async ({
  page,
}) => {
  await ready(page);
  await page.locator(".reveal").focus();
  await page.keyboard.press("w");
  await expect(board(page)).toHaveCount(1);
  await expect(page.locator(".reveal .slides > section.present")).toHaveAttribute("inert", "");
  const results = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(serious).toEqual([]);
  await page.keyboard.press("w");
  await expect(board(page)).toHaveCount(0);
  await expect(page.locator(".reveal .slides > section.present")).not.toHaveAttribute("inert", "");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the toolbar with the whiteboard toggle does not widen the page", async ({ page }) => {
    await ready(page);
    await page.getByRole("radio", { name: "Preview" }).click();
    await expect(page.getByRole("button", { name: "Whiteboard" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  });
});
