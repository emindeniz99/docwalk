import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { ready, replaceSource } from "./helpers";

/**
 * Countdown and pacing bar (decision 80), in the assembled app: the audience
 * window, a real presenter popup and a clock the test moves. `context.clock`
 * fakes `Date` and the timers in the main tab and in the popup, and lets time
 * run on by itself between jumps; each jump is one `fastForward`, so the
 * clocks are read with a few seconds of slack where the test cannot know how
 * long the browser took in between.
 */

const DOC = [
  "# Pace talk",
  "",
  "Cover.",
  ...["One", "Two", "Three", "Four"].flatMap((t) => ["", `## ${t}`, "", `Text ${t}.`]),
  "",
].join("\n");

async function openPresenter(page: Page, context: BrowserContext): Promise<Page> {
  const popup = context.waitForEvent("page");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popup;
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  return presenter;
}

/** The deck with five slides, the presenter window open on the slide "One". */
async function setUp(page: Page, context: BrowserContext): Promise<Page> {
  await context.clock.install();
  await ready(page);
  await replaceSource(page, DOC);
  await expect(page.getByRole("option", { name: /Four/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("option", { name: /One/ }).click();
  const presenter = await openPresenter(page, context);
  await expect(nowTitle(presenter)).toHaveText("One", { timeout: 30_000 });
  // The "Rendering previews" line takes room above the stage until the build is done.
  await expect(presenter.getByRole("status")).toBeEmpty({ timeout: 60_000 });
  return presenter;
}

const nowTitle = (presenter: Page) =>
  presenter.locator(".docwalk-presenter-current .docwalk-presenter-title");
// The countdown's timer under either name: it becomes "Over time" past zero (decision 135).
const timeLeft = (presenter: Page) =>
  presenter.getByRole("timer", { name: /^(Time left|Over time)$/ });
const elapsed = (presenter: Page) => presenter.getByRole("timer", { name: "Elapsed time" });
const bar = (presenter: Page, name: "Time used" | "Slides") =>
  presenter.getByRole("progressbar", { name });
const verdict = (presenter: Page) => presenter.locator(".docwalk-presenter-verdict");
const button = (presenter: Page, name: string) =>
  presenter.getByRole("button", { name, exact: true });

/** "9:05" is 545; "−0:05" is -5; "1:02:03" is 3723. */
async function seconds(clock: Locator): Promise<number> {
  const text = ((await clock.textContent()) ?? "").trim();
  const negative = text.startsWith("−");
  const parts = text.replace("−", "").split(":").map(Number);
  const total = parts.reduce((sum, part) => sum * 60 + part, 0);
  return negative ? -total : total;
}

async function startTarget(presenter: Page, minutes: string) {
  await presenter.getByLabel("Target (minutes)").fill(minutes);
  await button(presenter, "Start").click();
}

/** Moves the clock and waits until the presenter's own elapsed clock has seen it. */
async function jump(context: BrowserContext, presenter: Page, mmss: string) {
  const [m, s] = mmss.split(":").map(Number) as [number, number];
  const before = await seconds(elapsed(presenter));
  await context.clock.fastForward(mmss);
  await expect.poll(() => seconds(elapsed(presenter))).toBeGreaterThanOrEqual(before + m * 60 + s);
}

test("a target counts down in the presenter window, pauses, resumes and resets", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const presenter = await setUp(page, context);
  // No target yet: no clock face and no pacing bar.
  await expect(timeLeft(presenter)).toHaveCount(0);
  await expect(bar(presenter, "Slides")).toHaveCount(0);

  await startTarget(presenter, "10");
  await expect.poll(() => seconds(timeLeft(presenter))).toBeGreaterThan(590);

  await jump(context, presenter, "02:00");
  await expect.poll(() => seconds(timeLeft(presenter))).toBeLessThanOrEqual(480);
  await expect.poll(() => seconds(timeLeft(presenter))).toBeGreaterThan(470);

  // Paused, the time left stands still while the elapsed clock goes on.
  await button(presenter, "Pause").click();
  const held = await timeLeft(presenter).textContent();
  const heldSeconds = await seconds(timeLeft(presenter));
  await jump(context, presenter, "03:00");
  await expect(timeLeft(presenter)).toHaveText(held ?? "");
  await expect(button(presenter, "Resume")).toBeVisible();

  await button(presenter, "Resume").click();
  await jump(context, presenter, "01:00");
  // A minute went by after the resume, and none of the three before it.
  await expect.poll(() => seconds(timeLeft(presenter))).toBeLessThanOrEqual(heldSeconds - 58);
  await expect.poll(() => seconds(timeLeft(presenter))).toBeGreaterThan(heldSeconds - 75);

  // Reset returns to the field with the last minutes in it.
  await button(presenter, "Reset").click();
  await expect(timeLeft(presenter)).toHaveCount(0);
  await expect(bar(presenter, "Slides")).toHaveCount(0);
  await expect(presenter.getByLabel("Target (minutes)")).toHaveValue("10");
});

test("the pacing bar moves with the slide and with the clock, and says ahead, on pace, behind", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const presenter = await setUp(page, context);
  await presenter.getByRole("option", { name: /One/ }).click();
  await startTarget(presenter, "10");

  // The second of five slides: (1 + 0.5) / 5.
  await expect(bar(presenter, "Slides")).toHaveAttribute("aria-valuenow", "30");
  await expect(verdict(presenter)).toContainText("Ahead of schedule");

  await button(presenter, "Next slide").click();
  await expect(bar(presenter, "Slides")).toHaveAttribute("aria-valuenow", "50");

  await jump(context, presenter, "05:00");
  await expect(verdict(presenter)).toContainText("On pace");
  await jump(context, presenter, "03:00");
  await expect(verdict(presenter)).toContainText("Behind schedule");
  expect(await seconds(timeLeft(presenter))).toBeLessThan(130);
  await expect(bar(presenter, "Slides")).toHaveAttribute("aria-valuenow", "50");

  // Moving up the list moves the slide bar back.
  await presenter.getByRole("option", { name: /Pace talk/ }).click();
  await expect(bar(presenter, "Slides")).toHaveAttribute("aria-valuenow", "10");
});

test("running over the target shows negative time and a warning in words and an icon", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const presenter = await setUp(page, context);
  await startTarget(presenter, "2");
  await expect(presenter.locator('[data-over="true"]')).toHaveCount(0);

  await jump(context, presenter, "03:00");
  await expect.poll(() => seconds(timeLeft(presenter))).toBeLessThan(0);
  await expect(timeLeft(presenter)).toHaveText(/^−\d+:\d\d$/);
  // A screen reader hears the same words the eye reads (decision 135).
  await expect(presenter.getByRole("timer", { name: "Over time" })).toBeVisible();
  const over = presenter.locator('[data-over="true"]');
  await expect(over).toContainText("Over time");
  await expect(over.locator("svg")).toBeVisible();
  await expect(verdict(presenter)).toContainText("Over time");
  await expect(bar(presenter, "Time used")).toHaveAttribute("aria-valuenow", "100");
});

test("a reloaded presenter window keeps its countdown", async ({ page, context }) => {
  test.setTimeout(120_000);
  const presenter = await setUp(page, context);
  await startTarget(presenter, "10");
  await jump(context, presenter, "02:00");
  await presenter.reload();
  await expect(timeLeft(presenter)).toBeVisible({ timeout: 30_000 });
  const after = await seconds(timeLeft(presenter));
  expect(after).toBeLessThanOrEqual(480);
  expect(after).toBeGreaterThan(400);
  await expect(button(presenter, "Pause")).toBeVisible();
});

test("the presenter window still fits, with its notes panel and slide preview, while pacing", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const presenter = await setUp(page, context);
  const sizes = () =>
    presenter.evaluate(() => {
      // Runs in the page, so it cannot be moved out of this function.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const box = (selector: string) => {
        const r = document.querySelector(selector)?.getBoundingClientRect();
        return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
      };
      return {
        notes: box(".docwalk-presenter-notes"),
        frame: box(".docwalk-presenter-current .docwalk-presenter-frame"),
        fits:
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      };
    });
  const before = await sizes();
  await startTarget(presenter, "10");
  await expect(bar(presenter, "Slides")).toBeVisible();
  const after = await sizes();
  expect(after.fits).toBe(true);
  // The notes panel keeps its height; the slide gives up only what the bar takes.
  expect(after.notes).toEqual(before.notes);
  expect(after.frame?.h).toBeGreaterThan(150);
  expect(after.frame?.w).toBe(before.frame?.w);
});

for (const scheme of ["light", "dark"] as const) {
  test(`on a narrow window in ${scheme} mode the countdown and the pacing bar stay readable and inside the page`, async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const presenter = await setUp(page, context);
    await presenter.emulateMedia({ colorScheme: scheme });
    await presenter.setViewportSize({ width: 360, height: 700 });
    await startTarget(presenter, "2");
    await jump(context, presenter, "03:00");
    await expect(presenter.locator('[data-over="true"]')).toBeVisible();
    const group = presenter.getByRole("group", { name: "Pacing" });
    await group.scrollIntoViewIfNeeded();
    await expect(group).toBeInViewport();

    const fit = await presenter.evaluate(() => {
      // Runs in the page, so it cannot be moved out of this function.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const luminance = (css: string) => {
        const [red = 0, green = 0, blue = 0] = (css.match(/[\d.]+/g) ?? []).map(Number).map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      };
      /** Contrast of an element's text on the first opaque background above it. */
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const contrast = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector)!;
        let bg: Element | null = el;
        let back = "rgba(0, 0, 0, 0)";
        while (bg) {
          back = getComputedStyle(bg).backgroundColor;
          if (!/rgba\(.*, 0\)|transparent/.test(back)) break;
          bg = bg.parentElement;
        }
        const [a, b] = [luminance(getComputedStyle(el).color), luminance(back)];
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const right = Math.max(
        ...[...document.querySelectorAll<HTMLElement>(".docwalk-presenter-bar *")].map(
          (e) => e.getBoundingClientRect().right,
        ),
      );
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        right,
        clock: contrast('[data-over="true"] [role="timer"]'),
        label: contrast('[data-over="true"] .docwalk-presenter-label'),
        verdict: contrast(".docwalk-presenter-verdict"),
      };
    });
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.width);
    expect(fit.right).toBeLessThanOrEqual(fit.width);
    expect(fit.clock).toBeGreaterThanOrEqual(4.5);
    expect(fit.label).toBeGreaterThanOrEqual(4.5);
    expect(fit.verdict).toBeGreaterThanOrEqual(4.5);
  });
}
