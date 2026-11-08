import { afterEach, describe, expect, test, vi } from "vitest";
import { pollWhileVisible } from "./poll";

/** Pretends the page is `state`, as a switch to another tab or a minimised window does. */
function show(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  // Drops the own property, so the page's real visibility shows again.
  delete (document as { visibilityState?: unknown }).visibilityState;
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("polling the listing (decision 91)", () => {
  test("runs again and again while the page is visible", async () => {
    let calls = 0;
    const stop = pollWhileVisible(async () => void calls++, 20);
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3));
    stop();
  });

  test("does not run while the page is hidden, and runs at once when it shows again", async () => {
    // A background tab must not read a large folder every few seconds.
    show("hidden");
    let calls = 0;
    const stop = pollWhileVisible(async () => void calls++, 20);
    await wait(150);
    expect(calls).toBe(0);
    show("visible");
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
    stop();
  });

  test("waits 20 times as long as the last run took, so a huge folder costs a few percent of a core", async () => {
    let calls = 0;
    const stop = pollWhileVisible(async () => {
      calls++;
      await wait(30);
    }, 20);
    await wait(350);
    // The first run starts at about 20 ms, ends at about 50 ms, and the next one is due 600 ms later.
    expect(calls).toBe(1);
    stop();
  });

  test("never starts a run while the last one is still going", async () => {
    let running = 0;
    let overlapped = false;
    const stop = pollWhileVisible(async () => {
      if (++running > 1) overlapped = true;
      await wait(60);
      running--;
    }, 5);
    show("visible");
    show("visible");
    await wait(300);
    stop();
    expect(overlapped).toBe(false);
  });

  test("stops for good once stopped", async () => {
    let calls = 0;
    const stop = pollWhileVisible(async () => void calls++, 20);
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
    stop();
    const seen = calls;
    show("visible");
    await wait(150);
    expect(calls).toBe(seen);
  });
});
