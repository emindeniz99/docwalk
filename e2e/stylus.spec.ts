import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { fakeRelay, ready, replaceSource } from "./helpers";

/**
 * Stylus input (decision 110) across real pages. The policy and the layer
 * have unit tests with synthetic events. Here a Chromium pen reaches the page
 * as trusted events through CDP (so clicks really happen), and every engine
 * gets the same rules through synthetic pointer events. A real iPad with an
 * Apple Pencil is the owner's check (Scribble, hover, palm on glass).
 */

const DOC = [
  "# Pen talk",
  "",
  "## One",
  "",
  "Alpha text.",
  "",
  "[Go to two](#two)",
  "",
  "## Two",
  "",
  "Beta text.",
  "",
].join("\n");

const MARKS = ".docwalk-annotate-draw[data-active='true'] > *";
const counter = (page: Page) => page.locator(".docwalk-preview-head strong");
const slide = (page: Page) => page.locator(".reveal .slides > section.present");

async function openDoc(page: Page) {
  await ready(page);
  await replaceSource(page, DOC);
  await expect(page.locator(".docwalk-outline-item")).toHaveCount(3);
  await page.locator(".docwalk-outline-item").nth(1).click();
  await expect(counter(page)).toHaveText("2 / 3");
}

async function box(el: Locator) {
  const b = await el.boundingBox();
  if (!b) throw new Error("nothing to measure");
  return b;
}

// ---- Chromium: a trusted pen through the DevTools protocol ------------------

type Pen = (
  type: "mousePressed" | "mouseMoved" | "mouseReleased",
  x: number,
  y: number,
) => Promise<unknown>;

async function chromiumPen(context: BrowserContext, page: Page): Promise<Pen> {
  const cdp = await context.newCDPSession(page);
  return (type, x, y) =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: type === "mouseMoved" ? 0 : 1,
      pointerType: "pen",
    });
}

async function penStroke(pen: Pen, from: [number, number], to: [number, number], steps = 10) {
  await pen("mousePressed", ...from);
  for (let i = 1; i <= steps; i++) {
    await pen(
      "mouseMoved",
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps,
    );
  }
  await pen("mouseReleased", ...to);
}

test.describe("a pen through CDP", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "Input.dispatchMouseEvent is Chromium's",
  );

  test("a pen drag with no tool draws and the follower gets the stroke", async ({ context }) => {
    await fakeRelay(context);
    const presenter = await context.newPage();
    await openDoc(presenter);
    await presenter.getByRole("button", { name: "More actions" }).click();
    await presenter.getByRole("menuitem", { name: "Remote and followers…" }).click();
    const dialog = presenter.getByRole("dialog", { name: "Remote control" });
    await expect(dialog.getByText("Room open")).toBeVisible();
    const followUrl = await dialog.getByRole("textbox", { name: "Follow along link" }).inputValue();
    await dialog.getByRole("button", { name: "Close" }).click();
    const follower = await context.newPage();
    await follower.setViewportSize({ width: 900, height: 600 });
    await ready(follower, followUrl);
    await expect(counter(follower)).toHaveText("2 / 3");

    const pen = await chromiumPen(context, presenter);
    const s = await box(slide(presenter));
    await penStroke(
      pen,
      [s.x + s.width * 0.2, s.y + s.height * 0.8],
      [s.x + s.width * 0.7, s.y + s.height * 0.85],
    );
    await expect(presenter.locator(MARKS)).toHaveCount(1);
    await expect(follower.locator(".docwalk-mirror [data-mark]")).toHaveCount(1);
    // No tool was chosen for it, and none is now.
    await expect(presenter.getByRole("radio", { name: "Pen" })).not.toBeChecked();
    await expect(counter(presenter)).toHaveText("2 / 3");
  });

  test("a pen tap on a link follows it; a pen drag that ends over it does not", async ({
    context,
  }) => {
    const page = await context.newPage();
    await openDoc(page);
    const pen = await chromiumPen(context, page);
    const link = slide(page).getByRole("link", { name: "Go to two" });
    const first = await box(link);
    const at: [number, number] = [first.x + first.width / 2, first.y + first.height / 2];

    // Down on the link, away and back, up on it: a click would follow it if nothing swallowed it.
    await pen("mousePressed", ...at);
    for (const [dx, dy] of [
      [20, 20],
      [40, 40],
      [20, 20],
      [0, 0],
    ] as const) {
      await pen("mouseMoved", at[0] + dx, at[1] + dy);
    }
    await pen("mouseReleased", ...at);
    await expect(page.locator(MARKS)).toHaveCount(1);
    await expect(counter(page)).toHaveText("2 / 3");

    // A tap is no drag: the click goes through. The first pen's notice has pushed the page down.
    await expect(page.locator(".docwalk-notice")).toContainText("A pen is in use");
    const moved = await box(link);
    const tap: [number, number] = [moved.x + moved.width / 2, moved.y + moved.height / 2];
    await pen("mousePressed", ...tap);
    await pen("mouseReleased", ...tap);
    await expect(counter(page)).toHaveText("3 / 3");
  });
});

// ---- Every engine: the same rules through synthetic pointer events -----------

type Kind = "pen" | "touch" | "mouse";

/** A pointer's down, moves and up on `target`, as synthetic events (they bubble to window, as real ones do). */
async function drag(
  target: Locator,
  kind: Kind,
  from: [number, number],
  to: [number, number],
  { id = 5, steps = 10 }: { id?: number; steps?: number } = {},
) {
  const init = (x: number, y: number, down: boolean) => ({
    pointerId: id,
    pointerType: kind,
    isPrimary: true,
    button: 0,
    buttons: down ? 1 : 0,
    pressure: down ? 0.5 : 0,
    clientX: x,
    clientY: y,
  });
  await target.dispatchEvent("pointerdown", init(...from, true));
  for (let i = 1; i <= steps; i++) {
    await target.dispatchEvent(
      "pointermove",
      init(
        from[0] + ((to[0] - from[0]) * i) / steps,
        from[1] + ((to[1] - from[1]) * i) / steps,
        true,
      ),
    );
  }
  await target.dispatchEvent("pointerup", init(...to, false));
}

/** Two points on the slide's plain background, left of the link and below it. */
async function openArea(page: Page): Promise<{ a: [number, number]; b: [number, number] }> {
  const s = await box(slide(page));
  return {
    a: [s.x + s.width * 0.2, s.y + s.height * 0.8],
    b: [s.x + s.width * 0.7, s.y + s.height * 0.85],
  };
}

test("the first pen tells the viewer once that fingers now change slides, and a pen drag draws", async ({
  page,
}) => {
  await openDoc(page);
  const notice = page.locator(".docwalk-notice");
  await expect(notice).toHaveCount(0);
  const { a, b } = await openArea(page);
  await drag(slide(page), "pen", a, b);
  await expect(page.locator(MARKS)).toHaveCount(1);
  await expect(notice).toContainText("A pen is in use");
  await expect(notice).toContainText("Stylus draws, fingers change slides");

  // Once per browser: after a reload a pen touch says nothing.
  await page.reload();
  await expect(page.locator(".docwalk-statusbar")).toContainText(/\d+ slides?/, {
    timeout: 30_000,
  });
  await drag(slide(page), "pen", a, b);
  await expect(page.locator(".docwalk-notice")).toHaveCount(0);
});

test("after a pen, a swipe with the pen tool on changes slide and draws nothing", async ({
  page,
}) => {
  await openDoc(page);
  const { a, b } = await openArea(page);
  // One touch of the glass by a pen, then the pen tool.
  await drag(slide(page), "pen", a, a, { steps: 1 });
  await page.getByRole("radio", { name: "Pen" }).click();
  await expect(page.getByRole("radio", { name: "Pen" })).toBeChecked();

  // Before any pen a finger would draw here; now it swipes, and reveal.js moves on.
  const surface = page.locator(".docwalk-annotate-draw[data-active='true']");
  const s = await box(slide(page));
  await drag(
    surface,
    "touch",
    [s.x + s.width * 0.8, s.y + s.height * 0.5],
    [s.x + s.width * 0.2, s.y + s.height * 0.5],
    {
      id: 9,
    },
  );
  await expect(counter(page)).toHaveText("3 / 3");
  await expect(page.locator(MARKS)).toHaveCount(0);
  // The pen itself still draws with the tool.
  await drag(page.locator(".docwalk-annotate-draw[data-active='true']"), "pen", b, a);
  await expect(page.locator(MARKS)).toHaveCount(1);
});

test("after a pen, a finger's tap on the slide shows and hides the presenting controls whatever the tool", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Present" }).click();
  const app = page.locator(".docwalk-app");
  await expect(app).toHaveAttribute("data-view", "present");
  const area = await openArea(page);
  await drag(slide(page), "pen", area.a, area.a, { steps: 1 });
  await expect(app).toHaveAttribute("data-chrome", "hidden", { timeout: 10_000 });
  // A pen over the slide leaves hidden controls hidden, as a laser does: it is pointing, not asking.
  for (const dx of [0, 30, 60]) {
    await slide(page).dispatchEvent("pointermove", {
      pointerId: 5,
      pointerType: "pen",
      isPrimary: true,
      buttons: 0,
      clientX: area.a[0] + dx,
      clientY: area.a[1],
    });
  }
  await page.waitForTimeout(300);
  await expect(app).toHaveAttribute("data-chrome", "hidden");
  await page.keyboard.press("p");
  await expect(page.getByRole("radio", { name: "Pen" })).toBeChecked();
  // The key showed the controls; they hide again before the tap.
  await expect(app).toHaveAttribute("data-chrome", "hidden", { timeout: 10_000 });

  // The pen tool is on, and the tap is a finger's: it belongs to the page, not to ink.
  const tap = () =>
    drag(page.locator(".docwalk-annotate-draw[data-active='true']"), "touch", area.a, area.a, {
      id: 9,
      steps: 1,
    });
  await tap();
  await expect(app).not.toHaveAttribute("data-chrome", "hidden");
  await tap();
  await expect(app).toHaveAttribute("data-chrome", "hidden");
  await expect(page.locator(MARKS)).toHaveCount(0);
});

test("with 'Stylus draws, fingers change slides' off a pen drag in mode off draws nothing", async ({
  page,
}) => {
  await openDoc(page);
  const { a, b } = await openArea(page);
  await drag(slide(page), "pen", a, b);
  await expect(page.locator(MARKS)).toHaveCount(1);
  await page.getByRole("button", { name: "Undo mark" }).click();
  await expect(page.locator(MARKS)).toHaveCount(0);

  await page.getByRole("button", { name: "More actions" }).click();
  const item = page.getByRole("menuitemcheckbox", { name: "Stylus draws, fingers change slides" });
  await expect(item).toHaveAttribute("aria-checked", "true");
  await item.click();
  await expect(item).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => localStorage.getItem("docwalk.stylusAsMouse"))).toBe("true");

  await drag(slide(page), "pen", a, b, { id: 6 });
  await expect(page.locator(MARKS)).toHaveCount(0);
});
