import { afterEach, describe, expect, test, vi } from "vitest";
import { registerServiceWorker, UPDATE_CHECK_MS } from "./register";

/** Just enough of a ServiceWorker: its state and the messages the page sends it. */
class FakeWorker extends EventTarget {
  state: ServiceWorkerState = "installed";
  messages: unknown[] = [];
  postMessage(message: unknown) {
    this.messages.push(message);
  }
}

/** This tab's ServiceWorkerContainer, controlled by the old version, with a new one waiting. */
function fakeContainer() {
  const old = new FakeWorker();
  old.state = "activated";
  const waiting = new FakeWorker();
  const registration = Object.assign(new EventTarget(), {
    waiting,
    installing: null,
    update: vi.fn<() => Promise<void>>(async () => undefined),
  });
  const container = Object.assign(new EventTarget(), {
    controller: old as FakeWorker,
    register: vi.fn<() => Promise<typeof registration>>(async () => registration),
  });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  return { container, waiting, registration };
}

afterEach(() => {
  // The own property hides the real container; removing it brings that back.
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  delete (document as { visibilityState?: unknown }).visibilityState;
  delete (navigator as { onLine?: unknown }).onLine;
  vi.useRealTimers();
});

async function offered() {
  const reload = vi.fn<() => void>();
  let apply: (() => void) | null = null;
  registerServiceWorker((a) => {
    apply = a;
  }, reload);
  await expect.poll(() => apply).not.toBeNull();
  return { apply: apply! as () => void, reload };
}

describe("the update prompt's Reload button", () => {
  test("in the only tab it activates the waiting version, then reloads into it", async () => {
    const { container, waiting } = fakeContainer();
    const { apply, reload } = await offered();
    apply();
    expect(waiting.messages).toContainEqual({ type: "SKIP_WAITING" });
    // Reloading before the new worker controls the page would load the old version again.
    expect(reload).not.toHaveBeenCalled();
    waiting.state = "activated";
    container.controller = waiting;
    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).toHaveBeenCalledOnce();
  });

  test("in a second tab, after another tab already applied the update, it still reloads", async () => {
    // Both tabs showed the prompt. Reload in the first one activated the new
    // worker; this tab saw that controllerchange without having asked, so it
    // stayed. Its Reload then sent SKIP_WAITING to a worker that was already
    // active, no second controllerchange came, and the button did nothing
    // while the tab ran old code whose lazy chunks are no longer precached.
    const { container, waiting } = fakeContainer();
    const { apply, reload } = await offered();
    waiting.state = "activated";
    container.controller = waiting;
    container.dispatchEvent(new Event("controllerchange"));
    expect(reload).not.toHaveBeenCalled();

    apply();
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("checking for a new version while the page stays open (decision 99)", () => {
  /** A visible, online tab that registered a worker, with timers and the clock under test control. */
  async function openTab(state: { visible?: boolean; online?: boolean } = {}) {
    // Only the interval and the clock: the page's other timers keep running.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const fake = fakeContainer();
    show(state.visible ?? true);
    connect(state.online ?? true);
    registerServiceWorker(() => undefined, vi.fn<() => void>());
    // Let the mocked register() resolve and its handlers run.
    await vi.advanceTimersByTimeAsync(0);
    return fake;
  }
  const show = (visible: boolean) =>
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: visible ? "visible" : "hidden",
    });
  const connect = (online: boolean) =>
    Object.defineProperty(navigator, "onLine", { configurable: true, value: online });

  test("a visible online tab asks for sw.js once an hour, not sooner", async () => {
    const { registration } = await openTab();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS - 1);
    expect(registration.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(registration.update).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  test("a hidden tab does not wake the network, and asks when it is shown again", async () => {
    const { registration } = await openTab({ visible: false });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS * 3);
    expect(registration.update).not.toHaveBeenCalled();
    show(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(registration.update).toHaveBeenCalledOnce();
  });

  test("coming back to a tab that checked a minute ago does not ask again", async () => {
    const { registration } = await openTab();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
    expect(registration.update).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(registration.update).toHaveBeenCalledOnce();
  });

  test("offline it stays quiet, and a refused check leaves no unhandled rejection", async () => {
    const { registration } = await openTab({ online: false });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
    expect(registration.update).not.toHaveBeenCalled();

    // Online again, but the request fails (captive portal, server down).
    connect(true);
    registration.update.mockRejectedValue(new TypeError("Failed to update a ServiceWorker"));
    const unhandled = vi.fn<(event: PromiseRejectionEvent) => void>();
    window.addEventListener("unhandledrejection", unhandled);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
    await vi.advanceTimersByTimeAsync(0);
    window.removeEventListener("unhandledrejection", unhandled);
    expect(registration.update).toHaveBeenCalledOnce();
    expect(unhandled).not.toHaveBeenCalled();
  });
});
