import { afterEach, describe, expect, test, vi } from "vitest";
import { holdScreenAwake, type WakeLockEnv } from "./wakeLock";

/**
 * Screen Wake Lock (decision 80). These tests drive `holdScreenAwake` with a
 * stand-in for the browser's lock and page, because a test cannot make a
 * browser hide a tab or refuse a lock on demand. The real API under a real
 * page is exercised in e2e/wake-lock.spec.ts.
 */

class FakeSentinel extends EventTarget {
  released = false;
  release = vi.fn<() => Promise<void>>(() => {
    if (!this.released) {
      this.released = true;
      this.dispatchEvent(new Event("release"));
    }
    return Promise.resolve();
  });
}

function setup(options: { visible?: boolean; api?: boolean } = {}) {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn<(type: "screen") => Promise<FakeSentinel>>(() => {
    const sentinel = new FakeSentinel();
    sentinels.push(sentinel);
    return Promise.resolve(sentinel);
  });
  const page = new EventTarget();
  const doc = {
    visibilityState: (options.visible ?? true) ? "visible" : "hidden",
    addEventListener: vi.fn<(type: string, listener: () => void) => void>((type, listener) =>
      page.addEventListener(type, listener),
    ),
    removeEventListener: vi.fn<(type: string, listener: () => void) => void>((type, listener) =>
      page.removeEventListener(type, listener),
    ),
  };
  const env: WakeLockEnv = {
    navigator: (options.api ?? true) ? { wakeLock: { request } } : {},
    document: doc,
  };
  return {
    env,
    request,
    sentinels,
    setVisibility(state: "visible" | "hidden") {
      doc.visibilityState = state;
      page.dispatchEvent(new Event("visibilitychange"));
    },
    /** What a browser does when it hides a page: it releases the lock itself. */
    browserDrops(sentinel: FakeSentinel | undefined) {
      void sentinel?.release();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every console method and the unhandled-rejection event: the "no noise" contract. */
function watchNoise() {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  const rejections: unknown[] = [];
  const onRejection = (event: PromiseRejectionEvent) => rejections.push(event.reason);
  window.addEventListener("unhandledrejection", onRejection);
  return {
    async quiet() {
      await settle();
      await settle();
      window.removeEventListener("unhandledrejection", onRejection);
      expect(spies.flatMap((s) => s.mock.calls)).toEqual([]);
      expect(rejections).toEqual([]);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("holding the screen awake", () => {
  test("asks for a screen lock at once and lets it go when the caller leaves", async () => {
    const t = setup();
    const release = holdScreenAwake(t.env);
    await settle();
    expect(t.request).toHaveBeenCalledExactlyOnceWith("screen");
    expect(t.sentinels[0]?.released).toBe(false);

    release();
    expect(t.sentinels[0]?.released).toBe(true);
  });

  test("a lock that arrives after the caller already left is let go at once, so the screen is not kept awake for nobody", async () => {
    const t = setup();
    const late = new FakeSentinel();
    const arrival = Promise.withResolvers<FakeSentinel>();
    t.request.mockImplementationOnce(() => arrival.promise);
    const release = holdScreenAwake(t.env);
    release();
    arrival.resolve(late);
    await settle();
    expect(late.released).toBe(true);
  });

  test("asks again when the page becomes visible after the browser dropped the lock", async () => {
    const t = setup();
    const release = holdScreenAwake(t.env);
    await settle();
    // Hiding the page makes the browser release the lock on its own.
    t.setVisibility("hidden");
    t.browserDrops(t.sentinels[0]);
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);

    t.setVisibility("visible");
    await settle();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(t.sentinels[1]?.released).toBe(false);

    release();
    expect(t.sentinels[1]?.released).toBe(true);
  });

  test("does not ask while the page is hidden, because a hidden page is refused, and asks when it shows", async () => {
    const t = setup({ visible: false });
    const release = holdScreenAwake(t.env);
    await settle();
    expect(t.request).not.toHaveBeenCalled();

    t.setVisibility("visible");
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
    release();
  });

  test("keeps one lock when the page becomes visible while it still holds one", async () => {
    const t = setup();
    const release = holdScreenAwake(t.env);
    await settle();
    t.setVisibility("visible");
    t.setVisibility("visible");
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
    release();
  });

  test("stops listening for visibility once released, so a closed presenter never takes a lock again", async () => {
    const t = setup();
    const release = holdScreenAwake(t.env);
    await settle();
    release();
    t.setVisibility("hidden");
    t.setVisibility("visible");
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.env.document.removeEventListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
  });

  test("releasing twice is harmless", async () => {
    const t = setup();
    const release = holdScreenAwake(t.env);
    await settle();
    release();
    expect(() => release()).not.toThrow();
  });
});

describe("when the lock is unavailable", () => {
  test("a browser without the API carries on without a word", async () => {
    const noise = watchNoise();
    const t = setup({ api: false });
    const release = holdScreenAwake(t.env);
    release();
    await noise.quiet();
    expect(t.env.navigator.wakeLock).toBeUndefined();
  });

  test("a refused request carries on without a word and without retrying in a loop", async () => {
    const noise = watchNoise();
    const t = setup();
    t.request.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const release = holdScreenAwake(t.env);
    await settle();
    await settle();
    expect(t.request).toHaveBeenCalledTimes(1);
    release();
    await noise.quiet();
    expect(t.request).toHaveBeenCalledTimes(1);
  });

  test("a request that throws before it returns a promise is handled the same way", async () => {
    const noise = watchNoise();
    const t = setup();
    t.request.mockImplementation(() => {
      throw new TypeError("not a function");
    });
    const release = holdScreenAwake(t.env);
    release();
    await noise.quiet();
    expect(t.request).toHaveBeenCalledTimes(1);
  });

  test("after a refusal the next visible page tries once more", async () => {
    const t = setup();
    t.request.mockRejectedValueOnce(new DOMException("low battery", "NotAllowedError"));
    const release = holdScreenAwake(t.env);
    await settle();
    t.setVisibility("visible");
    await settle();
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(t.sentinels).toHaveLength(1);
    release();
  });

  test("a release that fails is swallowed", async () => {
    const noise = watchNoise();
    const t = setup();
    const release = holdScreenAwake(t.env);
    await settle();
    t.sentinels[0]?.release.mockRejectedValue(new DOMException("gone", "AbortError"));
    release();
    await noise.quiet();
    expect(t.sentinels[0]?.release).toHaveBeenCalledTimes(1);
  });
});

describe("with the real page", () => {
  test("defaults to this page's navigator and document", async () => {
    const lock = new FakeSentinel();
    const request = vi.fn<() => Promise<FakeSentinel>>(() => Promise.resolve(lock));
    // Chromium defines `wakeLock` on the Navigator prototype: shadow it on the instance.
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    try {
      const release = holdScreenAwake();
      await settle();
      expect(request).toHaveBeenCalledExactlyOnceWith("screen");
      release();
      expect(lock.released).toBe(true);
    } finally {
      Reflect.deleteProperty(navigator, "wakeLock");
    }
  });
});
