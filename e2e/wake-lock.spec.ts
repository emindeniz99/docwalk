import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ready } from "./helpers";

/**
 * Screen Wake Lock (decision 80), in the assembled app. Two kinds of test:
 *
 * - "real": a recorder wraps the browser's own `navigator.wakeLock.request`
 *   and passes every call through, so the lock is the browser's, and the test
 *   reads back what was asked and whether it is still held. Only Chromium
 *   runs these, as it is the engine whose Playwright build ships the API.
 *   Hiding a page cannot be done from a test, so those steps flip
 *   `document.visibilityState` and fire the event, and drop the lock with
 *   the sentinel's own `release()`, which is what a browser does to a hidden
 *   page.
 * - "stand-in": a missing API, or one that refuses, built in the page, to
 *   check that the app says nothing at all about it. These run everywhere.
 */

interface Recorder {
  calls: string[];
  sentinels: { released: boolean; release(): Promise<void> }[];
  failures: string[];
}
type WithRecorder = { wakeRecorder: Recorder };

/** Wraps the real API and records each call; the browser still decides. */
function recordRealApi() {
  const recorder: Recorder = { calls: [], sentinels: [], failures: [] };
  (window as unknown as WithRecorder).wakeRecorder = recorder;
  const lock = navigator.wakeLock;
  const real = lock.request.bind(lock);
  Object.defineProperty(lock, "request", {
    configurable: true,
    value: async (type: "screen") => {
      recorder.calls.push(type);
      try {
        const sentinel = await real(type);
        recorder.sentinels.push(sentinel);
        return sentinel;
      } catch (error) {
        recorder.failures.push(String(error));
        throw error;
      }
    },
  });
}

/** A browser whose API refuses every request. */
function refusingApi() {
  const recorder: Recorder = { calls: [], sentinels: [], failures: [] };
  (window as unknown as WithRecorder).wakeRecorder = recorder;
  const refuse = (type: string) => {
    recorder.calls.push(type);
    return Promise.reject(new DOMException("refused for the test", "NotAllowedError"));
  };
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: refuse } });
}

/** A browser without the API. */
function noApi() {
  Object.defineProperty(Navigator.prototype, "wakeLock", { configurable: true, value: undefined });
}

const recorder = (page: Page) =>
  page.evaluate(() => {
    const r = (window as unknown as WithRecorder).wakeRecorder;
    return r
      ? {
          calls: r.calls.length,
          held: r.sentinels.filter((s) => !s.released).length,
          total: r.sentinels.length,
          failures: r.failures,
        }
      : null;
  });

function setVisibility(page: Page, state: "visible" | "hidden") {
  return page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => next });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

/** What a browser does to a hidden page: lets go of its locks. */
function browserDropsLocks(page: Page) {
  return page.evaluate(async () => {
    const r = (window as unknown as WithRecorder).wakeRecorder;
    await Promise.all((r?.sentinels ?? []).map((s) => s.release()));
  });
}

async function present(page: Page) {
  await ready(page);
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
}

async function leave(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(".docwalk-app")).not.toHaveAttribute("data-view", "present");
}

async function openPresenter(page: Page, context: BrowserContext): Promise<Page> {
  const popup = context.waitForEvent("page");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("presenter");
  await page.getByRole("menuitem", { name: "Open presenter view" }).click();
  const presenter = await popup;
  await expect(presenter.getByText("Now", { exact: true })).toBeVisible({ timeout: 30_000 });
  return presenter;
}

/** Everything any page of the context says to the console or throws, apart from plain logs. */
function collectNoise(context: BrowserContext) {
  const noise: string[] = [];
  context.on("console", (message) => {
    if (!["warning", "error"].includes(message.type())) return;
    const text = `${message.type()}: ${message.text()}`;
    // Both appear in every run of this build under Playwright, with or without a lock:
    // the config blocks the service worker, and the static server has no /api/health.
    if (/Service Worker registration blocked|status of 404/.test(text)) return;
    noise.push(text);
  });
  context.on("weberror", (error) => noise.push(`pageerror: ${error.error().message}`));
  return noise;
}

test.describe("the browser's own lock", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Only Chromium's build ships the API");

  test("is taken when presenting starts and let go when it ends", async ({ page, context }) => {
    await context.addInitScript(recordRealApi);
    await ready(page);
    expect(await recorder(page)).toMatchObject({ calls: 0, held: 0 });

    await page.getByRole("button", { name: "Present" }).click();
    await expect.poll(() => recorder(page)).toMatchObject({ calls: 1, held: 1, failures: [] });

    await leave(page);
    await expect.poll(() => recorder(page)).toMatchObject({ calls: 1, held: 0, total: 1 });
  });

  test("is taken again when the page becomes visible after the browser dropped it", async ({
    page,
    context,
  }) => {
    await context.addInitScript(recordRealApi);
    await present(page);
    await expect.poll(() => recorder(page)).toMatchObject({ held: 1 });

    await setVisibility(page, "hidden");
    await browserDropsLocks(page);
    await expect.poll(() => recorder(page)).toMatchObject({ calls: 1, held: 0 });

    await setVisibility(page, "visible");
    await expect.poll(() => recorder(page)).toMatchObject({ calls: 2, held: 1 });

    await leave(page);
    await expect.poll(() => recorder(page)).toMatchObject({ held: 0 });
    // Leaving also stops listening: showing the page again asks for nothing.
    await setVisibility(page, "hidden");
    await setVisibility(page, "visible");
    await expect.poll(() => recorder(page)).toMatchObject({ calls: 2, held: 0 });
  });

  test("is held by an open presenter window, and let go when that window closes", async ({
    page,
    context,
  }) => {
    await context.addInitScript(recordRealApi);
    await ready(page);
    const presenter = await openPresenter(page, context);
    await expect.poll(() => recorder(presenter)).toMatchObject({ calls: 1, held: 1, failures: [] });
    // The audience tab is not presenting, so it holds nothing.
    expect(await recorder(page)).toMatchObject({ calls: 0, held: 0 });

    await presenter.close();
    // The closing window is gone; the audience tab still holds nothing.
    expect(await recorder(page)).toMatchObject({ calls: 0, held: 0 });
  });
});

test.describe("a browser that cannot or will not lock the screen", () => {
  test("without the API, presenting and the presenter window work and say nothing", async ({
    page,
    context,
  }) => {
    await context.addInitScript(noApi);
    const noise = collectNoise(context);
    await present(page);
    expect(await page.evaluate(() => navigator.wakeLock === undefined)).toBe(true);
    await leave(page);
    await present(page);
    await leave(page);
    const presenter = await openPresenter(page, context);
    await expect(presenter.getByRole("timer", { name: "Elapsed time" })).toBeVisible();
    await setVisibility(presenter, "hidden");
    await setVisibility(presenter, "visible");
    expect(noise).toEqual([]);
  });

  test("when every request is refused, presenting works, nothing is printed and nothing is retried in a loop", async ({
    page,
    context,
  }) => {
    await context.addInitScript(refusingApi);
    const noise = collectNoise(context);
    await present(page);
    await expect.poll(() => recorder(page)).toMatchObject({ calls: 1, held: 0 });
    // A refused page is not asked again until it is shown again.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    expect(await recorder(page)).toMatchObject({ calls: 1 });
    await expect(page.locator(".docwalk-app")).toHaveAttribute("data-view", "present");
    await leave(page);

    const presenter = await openPresenter(page, context);
    await expect.poll(() => recorder(presenter)).toMatchObject({ calls: 1 });
    await expect(presenter.getByRole("timer", { name: "Elapsed time" })).toBeVisible();
    expect(noise).toEqual([]);
  });
});
