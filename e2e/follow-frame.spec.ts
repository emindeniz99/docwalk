import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { fakeRelay, ready, replaceSource, SHORT_DOC } from "./helpers";

/**
 * Fill frame and idle chrome on follow screens (decision 113, refining 75
 * and 77). A follow screen showed 49's card on the dark stage under the
 * app's header, a bar and the status bar, so a room's second screen showed a
 * smaller slide than the presenter's. These tests guard that it takes the
 * presenting layout: the slide's share of the screen, the ground behind it,
 * the chrome that hides when idle, the follow status that stays readable
 * (and stays up while the slide may be frozen), and the card frame for a
 * browser that chose it.
 */

const HIDE_TIMEOUT = 10_000;
const CARD_KEY = "docwalk.presentCardFrame";

const app = (page: Page) => page.locator(".docwalk-app");
const bar = (page: Page) => page.locator(".docwalk-preview-head");
const slide = (page: Page) => page.locator(".reveal .slides > section.present");

test.use({ viewport: { width: 1440, height: 900 } });

/** A presenter with a room open; returns the follow link and the relay. */
async function openRoom(context: BrowserContext) {
  const relay = await fakeRelay(context);
  const presenter = await context.newPage();
  await ready(presenter);
  // A short pasted document: its #doc= link fits the relay's frame for followers.
  await replaceSource(presenter, SHORT_DOC);
  await expect(presenter.locator(".docwalk-outline-item")).toHaveCount(3);
  await presenter.getByRole("button", { name: "More actions" }).click();
  await presenter.getByRole("menuitem", { name: "Remote and followers…" }).click();
  const dialog = presenter.getByRole("dialog", { name: "Remote control" });
  await expect(dialog.getByText("Room open")).toBeVisible();
  const followUrl = await dialog.getByRole("textbox", { name: "Follow along link" }).inputValue();
  await dialog.getByRole("button", { name: "Close" }).click();
  return { relay, presenter, followUrl };
}

/** A follower that has loaded the presenter's document and shows its first slide. */
async function follow(context: BrowserContext) {
  const room = await openRoom(context);
  const follower = await context.newPage();
  await ready(follower, room.followUrl);
  await expect(bar(follower).locator("strong")).toHaveText(/^\d+ \/ 3$/);
  return { ...room, follower };
}

async function box(page: Page) {
  const b = await slide(page).boundingBox();
  if (!b) throw new Error("no slide");
  return b;
}

const background = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);

test("a follow screen fills the screen as the presenter's does", async ({ context }) => {
  const { follower } = await follow(context);
  await expect(app(follower)).toHaveAttribute("data-chrome", "hidden", { timeout: HIDE_TIMEOUT });
  await follower.waitForTimeout(300);
  // 77 measured the presenter's fill frame at 89% of a 1440x900 viewport's area (card: 72.5%).
  const b = await box(follower);
  expect((b.width * b.height) / (1440 * 900)).toBeGreaterThanOrEqual(0.88);
  // The rest of the screen reads as more slide, not as dark bars.
  const paper = await background(follower, ".reveal .slides > section.present .docwalk-slide");
  for (const layer of [".docwalk-app", ".docwalk-deck-pane", ".docwalk-deck"])
    expect(await background(follower, layer), layer).toBe(paper);
  // Pagination stays the presenter's: the follower's slide is still the fixed 16:9 box.
  expect(b.width / b.height).toBeCloseTo(16 / 9, 1);
});

test("its bar hides after 3 s idle and a mouse move brings it back", async ({ context }) => {
  const { follower } = await follow(context);
  await expect(app(follower)).toHaveAttribute("data-chrome", "hidden", { timeout: HIDE_TIMEOUT });
  await expect(bar(follower)).toHaveCSS("opacity", "0");
  // The first hide says how to get the bar back (decision 75).
  await expect(follower.locator(".docwalk-chrome-hint")).toHaveText(/\S/);
  await follower.mouse.move(200, 200);
  await follower.mouse.move(260, 240);
  await expect(app(follower)).toHaveAttribute("data-chrome", "shown");
  await expect(bar(follower)).toHaveCSS("opacity", "1");
});

test("the follow status lives in the bar, as a status, and the header and status bar are gone", async ({
  context,
}) => {
  const { follower } = await follow(context);
  await expect(bar(follower).getByRole("status")).toHaveText("Following the presenter");
  // One status with that text: a second one in the hidden header would read twice.
  await expect(
    follower.getByRole("status").filter({ hasText: "Following the presenter" }),
  ).toHaveCount(1);
  await expect(bar(follower).getByRole("button", { name: /theme/i })).toBeVisible();
  await expect(follower.locator(".docwalk-toolbar")).toBeHidden();
  await expect(follower.locator(".docwalk-statusbar")).toBeHidden();
});

test("an incomplete follow link keeps the bar up, saying why", async ({ context }) => {
  const { followUrl } = await openRoom(context);
  const incomplete = followUrl.replace(/&p=[\w-]+/, "");
  expect(incomplete).not.toBe(followUrl);
  const follower = await context.newPage();
  await follower.goto(incomplete);
  await expect(bar(follower).getByRole("status")).toHaveText("Not connected");
  await follower.waitForTimeout(4000);
  await expect(app(follower)).not.toHaveAttribute("data-chrome", "hidden");
  await expect(bar(follower)).toHaveCSS("opacity", "1");
});

test("a lost connection brings the bar back and keeps it up", async ({ context }) => {
  const { follower, relay } = await follow(context);
  await expect(app(follower)).toHaveAttribute("data-chrome", "hidden", { timeout: HIDE_TIMEOUT });
  relay.state.refuseFollowers = true;
  await relay.dropFollowers();
  await expect(bar(follower).getByRole("status")).not.toHaveText("Following the presenter");
  await expect(app(follower)).not.toHaveAttribute("data-chrome", "hidden");
  await follower.waitForTimeout(4000);
  await expect(app(follower)).not.toHaveAttribute("data-chrome", "hidden");
  await expect(bar(follower)).toHaveCSS("opacity", "1");
});

test("with the card chosen in this browser, a follow screen shows the card", async ({
  context,
}) => {
  await context.addInitScript((key) => localStorage.setItem(key, "true"), CARD_KEY);
  const { follower } = await follow(context);
  await expect(app(follower)).toHaveAttribute("data-frame", "card");
  const paper = await background(follower, ".reveal .slides > section.present .docwalk-slide");
  // Decision 49's dark stage stays around the card.
  expect(await background(follower, ".docwalk-app")).not.toBe(paper);
  const card = slide(follower).locator(".docwalk-slide");
  await expect(card).not.toHaveCSS("border-radius", "0px");
  // reveal.js keeps its 10% margin: the card never reaches the screen's edges.
  expect((await box(follower)).width).toBeLessThanOrEqual(1440 * 0.9 + 1);
});
