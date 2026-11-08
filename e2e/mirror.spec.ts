import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { fakeRelay, ready, replaceSource } from "./helpers";

/**
 * Mirroring the presenter's laser, marks and diagram focus (decision 88)
 * across real pages. The relay is played by `fakeRelay`, as in remote.spec.ts;
 * the presenter window is a real popup that talks over BroadcastChannel and
 * needs no Worker. The follower is a different size on purpose: marks travel
 * in slide units, so they must land on the same spot of a smaller screen.
 */

const SHOTS = process.env["DOCWALK_SHOTS"];

const DOC = [
  "# Mirror talk",
  "",
  "## One",
  "",
  "Alpha.",
  "",
  "## Diagram",
  "",
  "```mermaid",
  "flowchart LR",
  "  a --> b",
  "```",
  "",
  "## Three",
  "",
  "Gamma.",
  "",
].join("\n");

const MARKS = ".docwalk-annotate-draw[data-active='true'] > *";

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Where the centre of `el` sits inside `frame`, as fractions of the frame. */
async function inside(el: Locator, frame: Locator) {
  const [a, f] = await Promise.all([el.boundingBox(), frame.boundingBox()]);
  if (!a || !f) throw new Error("nothing to measure");
  return { x: (a.x + a.width / 2 - f.x) / f.width, y: (a.y + a.height / 2 - f.y) / f.height };
}

/** One pen stroke across the presenter's overlay, from (x0, y0) to (x1, y1) as fractions of it. */
async function stroke(page: Page, from: [number, number], to: [number, number]) {
  const r = await page.locator(".docwalk-annotate").boundingBox();
  if (!r) throw new Error("annotation overlay missing");
  await page.mouse.move(r.x + r.width * from[0], r.y + r.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * to[0], r.y + r.height * to[1], { steps: 14 });
  await page.mouse.up();
}

async function openPresenterRoom(context: BrowserContext) {
  const presenter = await context.newPage();
  await ready(presenter);
  await replaceSource(presenter, DOC);
  await expect(presenter.locator(".docwalk-outline-item")).toHaveCount(4);
  await presenter.getByRole("button", { name: "More actions" }).click();
  await presenter.getByRole("menuitem", { name: "Remote and followers…" }).click();
  const dialog = presenter.getByRole("dialog", { name: "Remote control" });
  await expect(dialog.getByText("Room open")).toBeVisible();
  const followUrl = await dialog.getByRole("textbox", { name: "Follow along link" }).inputValue();
  await dialog.getByRole("button", { name: "Close" }).click();
  await presenter.locator(".docwalk-outline-item").first().click();
  await expect(presenter.locator(".docwalk-preview-head strong")).toHaveText("1 / 4");
  return { presenter, followUrl };
}

async function openFollower(
  context: BrowserContext,
  url: string,
  size = { width: 900, height: 600 },
) {
  const follower = await context.newPage();
  await follower.setViewportSize(size);
  await ready(follower, url);
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText(/\/ 4$/);
  return follower;
}

test("a follower sees the presenter's strokes, undo, clear, slide changes, laser and diagram focus", async ({
  context,
}) => {
  await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  const follower = await openFollower(context, followUrl);
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText("1 / 4");
  const marks = follower.locator(".docwalk-mirror [data-mark]");
  await expect(marks).toHaveCount(0);

  // A stroke lands in slide units: the same fractions of the slide on a smaller screen.
  await presenter.getByRole("radio", { name: "Pen" }).click();
  await stroke(presenter, [0.2, 0.4], [0.6, 0.5]);
  await expect(marks).toHaveCount(1);
  const mine = await inside(
    presenter.locator(`${MARKS} >> nth=0`),
    presenter.locator(".docwalk-annotate"),
  );
  const theirs = await inside(marks.first(), follower.locator(".docwalk-mirror"));
  expect(Math.abs(mine.x - theirs.x)).toBeLessThan(0.03);
  expect(Math.abs(mine.y - theirs.y)).toBeLessThan(0.03);
  await shot(follower, "follower-stroke");

  // Undo and clear reach the follower; redoing sends the stroke again.
  await stroke(presenter, [0.2, 0.7], [0.7, 0.75]);
  await expect(marks).toHaveCount(2);
  await presenter.getByRole("button", { name: "Undo mark" }).click();
  await expect(marks).toHaveCount(1);
  await presenter.keyboard.press("ControlOrMeta+Shift+z");
  await expect(marks).toHaveCount(2);
  await presenter.getByRole("button", { name: "Clear marks" }).click();
  await expect(marks).toHaveCount(0);

  // Each slide keeps its own marks, and a change of slide brings the right ones.
  await stroke(presenter, [0.3, 0.3], [0.5, 0.6]);
  await expect(marks).toHaveCount(1);
  await presenter.locator(".reveal").focus();
  await presenter.keyboard.press("ArrowRight");
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText("2 / 4");
  await expect(marks).toHaveCount(0);
  await presenter.keyboard.press("ArrowLeft");
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText("1 / 4");
  await expect(marks).toHaveCount(1);

  // A follower that joins late gets the marks of the current slide.
  const late = await openFollower(context, followUrl, { width: 700, height: 500 });
  await expect(late.locator(".docwalk-preview-head strong")).toHaveText("1 / 4");
  await expect(late.locator(".docwalk-mirror [data-mark]")).toHaveCount(1);

  // The laser follows the presenter's pointer and goes when it leaves the slide.
  await presenter.getByRole("radio", { name: "Laser pointer" }).click();
  const frame = await presenter.locator(".docwalk-annotate").boundingBox();
  if (!frame) throw new Error("annotation overlay missing");
  const dot = follower.locator(".docwalk-mirror .docwalk-remote-laser");
  await presenter.mouse.move(frame.x + frame.width * 0.25, frame.y + frame.height * 0.75);
  await presenter.mouse.move(frame.x + frame.width * 0.25, frame.y + frame.height * 0.75 + 2);
  await expect(dot).toBeVisible();
  await expect
    .poll(async () => (await inside(dot, follower.locator(".docwalk-mirror"))).x)
    .toBeGreaterThan(0.2);
  const at = await inside(dot, follower.locator(".docwalk-mirror"));
  expect(Math.abs(at.x - 0.25)).toBeLessThan(0.03);
  expect(Math.abs(at.y - 0.75)).toBeLessThan(0.04);
  await shot(follower, "follower-laser");
  await presenter.mouse.move(2, 2);
  await expect(dot).toBeHidden();
  await presenter.getByRole("radio", { name: "Laser pointer" }).click();

  // The diagram focus view opens on the same diagram and follows zoom.
  await presenter.getByRole("option", { name: /Diagram/ }).click();
  await expect(follower.locator(".docwalk-preview-head strong")).toHaveText("3 / 4");
  await presenter.locator(".reveal .slides section.present .docwalk-diagram").click();
  await expect(presenter.locator(".docwalk-focus")).toBeVisible();
  const view = follower.locator(".docwalk-focus[data-kind='diagram']");
  await expect(view).toBeVisible();
  const scale = async () =>
    Number(
      /scale\(([\d.]+)\)/.exec(
        (await view.locator(".docwalk-focus-canvas").getAttribute("style")) ?? "",
      )?.[1] ?? "1",
    );
  await presenter.getByRole("button", { name: "Zoom in" }).click();
  await presenter.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(scale).toBeGreaterThan(1.3);
  await shot(follower, "follower-focus");
  await presenter.keyboard.press("Escape");
  await expect(presenter.locator(".docwalk-focus")).toHaveCount(0);
  await expect(view).toHaveCount(0);
});

test("a follower that lost its connection gets the missed marks and the closed focus view back", async ({
  context,
}) => {
  const relay = await fakeRelay(context);
  const { presenter, followUrl } = await openPresenterRoom(context);
  const follower = await openFollower(context, followUrl);
  const marks = follower.locator(".docwalk-mirror [data-mark]");
  await presenter.getByRole("radio", { name: "Pen" }).click();
  await stroke(presenter, [0.2, 0.4], [0.6, 0.5]);
  await expect(marks).toHaveCount(1);

  // While the follower is cut off the presenter adds a stroke and clears the first.
  relay.state.refuseFollowers = true;
  await relay.dropFollowers();
  await stroke(presenter, [0.2, 0.7], [0.7, 0.75]);
  await presenter.getByRole("button", { name: "Undo mark" }).click();
  await stroke(presenter, [0.2, 0.2], [0.4, 0.3]);
  await expect(presenter.locator(MARKS)).toHaveCount(2);
  relay.state.refuseFollowers = false;

  // It reconnects on its own, says hello, and the presenter sends the slide's marks again.
  await expect(marks).toHaveCount(2, { timeout: 20_000 });
  const mine = await inside(
    presenter.locator(`${MARKS} >> nth=1`),
    presenter.locator(".docwalk-annotate"),
  );
  const theirs = await inside(marks.nth(1), follower.locator(".docwalk-mirror"));
  expect(Math.abs(mine.x - theirs.x)).toBeLessThan(0.03);
});

test("without a Worker the presenter window still mirrors the laser and the marks", async ({
  page,
  context,
}) => {
  // No /api here: the remote controls are hidden and the window talks over BroadcastChannel.
  await ready(page);
  await replaceSource(page, DOC);
  await expect(page.locator(".docwalk-outline-item")).toHaveCount(4);
  await page.locator(".docwalk-outline-item").first().click();
  await page.getByRole("radio", { name: "Pen" }).click();
  await stroke(page, [0.2, 0.4], [0.6, 0.5]);

  const popup = context.waitForEvent("page");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popup;
  await presenter.setViewportSize({ width: 1280, height: 800 });
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });

  // The window opened after the stroke and still has it.
  const marks = presenter.locator(".docwalk-presenter-current .docwalk-mirror [data-mark]");
  await expect(marks).toHaveCount(1, { timeout: 30_000 });
  await stroke(page, [0.2, 0.7], [0.7, 0.75]);
  await expect(marks).toHaveCount(2);
  await shot(presenter, "presenter-window-marks");

  await page.getByRole("radio", { name: "Laser pointer" }).click();
  const frame = await page.locator(".docwalk-annotate").boundingBox();
  if (!frame) throw new Error("annotation overlay missing");
  await page.mouse.move(frame.x + frame.width * 0.5, frame.y + frame.height * 0.5);
  await page.mouse.move(frame.x + frame.width * 0.5, frame.y + frame.height * 0.5 + 2);
  await expect(presenter.locator(".docwalk-presenter-current .docwalk-remote-laser")).toBeVisible();
  await shot(presenter, "presenter-window-laser");
  await page.mouse.move(2, 2);
  await expect(presenter.locator(".docwalk-presenter-current .docwalk-remote-laser")).toBeHidden();

  await page.getByRole("radio", { name: "Laser pointer" }).click();
  await page.locator(".docwalk-outline-item").nth(1).click();
  await expect(marks).toHaveCount(0);
});
