import { afterEach, describe, expect, test, vi } from "vitest";
import { registerServiceWorker } from "./register";

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
  const registration = Object.assign(new EventTarget(), { waiting, installing: null });
  const container = Object.assign(new EventTarget(), {
    controller: old as FakeWorker,
    register: vi.fn<() => Promise<typeof registration>>(async () => registration),
  });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  return { container, waiting };
}

afterEach(() => {
  // The own property hides the real container; removing it brings that back.
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
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
