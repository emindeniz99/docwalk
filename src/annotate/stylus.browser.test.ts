import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Pen detection and pen drags on the stage (decision 110). `pointerType` is
 * settable in the PointerEvent constructor, so synthetic events stand in for
 * a pen here; the trusted version, with clicks that really follow a link, is
 * the Chromium e2e spec of the wiring step.
 */

// The setting and the latch are module state. Vitest's browser mode runs native
// ES modules, where `vi.resetModules` does nothing, so a query string gives each
// test its own copy of the module.
let copies = 0;
async function load(): Promise<typeof import("./stylus")> {
  return import(/* @vite-ignore */ `./stylus.ts?copy=${++copies}`);
}

let stage: HTMLElement;
let link: HTMLAnchorElement;
let outside: HTMLElement;
const disposers: (() => void)[] = [];

beforeEach(() => {
  stage = document.createElement("div");
  stage.className = "slides";
  link = document.createElement("a");
  link.href = "#somewhere";
  link.textContent = "link";
  stage.append(link);
  outside = document.createElement("div");
  document.body.append(stage, outside);
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.removeItem("docwalk.stylusAsMouse");
  vi.useRealTimers();
});

function pointer(
  type: string,
  target: EventTarget,
  init: PointerEventInit & { pointerType?: string } = {},
) {
  const event = new PointerEvent(type, {
    pointerId: 1,
    pointerType: "pen",
    isPrimary: true,
    button: type === "pointerdown" ? 0 : -1,
    buttons: type === "pointerup" ? 0 : 1,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

/**
 * Click the link and report whether the click reached it. `detail` is the
 * click count: 1 for a click a pointer made, 0 for Enter, Space or a script.
 */
function clickReaches(detail = 1): boolean {
  let reached = false;
  const onClick = (event: Event) => {
    reached = true;
    event.preventDefault(); // keep the test page where it is
  };
  link.addEventListener("click", onClick);
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
  link.removeEventListener("click", onClick);
  return reached;
}

/** Watch the stage and return the onDrag spy. */
async function watch(enabled = () => true) {
  const { watchPenDrags } = await load();
  const onDrag = vi.fn<(down: PointerEvent) => void>();
  disposers.push(watchPenDrags(stage, { enabled, onDrag }));
  return onDrag;
}

describe("watchPenDrags", () => {
  test("a pen tap calls no onDrag and its click reaches the link, so a tap still follows a link", async () => {
    const onDrag = await watch();
    pointer("pointerdown", link, { clientX: 50, clientY: 50 });
    pointer("pointermove", link, { clientX: 52, clientY: 51 });
    pointer("pointerup", link, { clientX: 52, clientY: 51 });
    expect(onDrag).not.toHaveBeenCalled();
    expect(clickReaches()).toBe(true);
  });

  test("a 10 px pen drag calls onDrag once with the pointerdown, so the stroke starts where the pen went down", async () => {
    const onDrag = await watch();
    const down = pointer("pointerdown", link, { clientX: 50, clientY: 50, pressure: 0.4 });
    pointer("pointermove", link, { clientX: 55, clientY: 50 });
    pointer("pointermove", link, { clientX: 60, clientY: 50 });
    pointer("pointermove", link, { clientX: 70, clientY: 50 });
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onDrag.mock.calls[0]![0]).toBe(down);
    expect(onDrag.mock.calls[0]![0].clientX).toBe(50);
  });

  test("a drag under 4 CSS px never promotes, so a hand tremor on a tap is no stroke", async () => {
    const onDrag = await watch();
    pointer("pointerdown", link, { clientX: 50, clientY: 50 });
    pointer("pointermove", link, { clientX: 52, clientY: 52 });
    pointer("pointermove", link, { clientX: 53, clientY: 52 });
    expect(onDrag).not.toHaveBeenCalled();
    pointer("pointermove", link, { clientX: 55, clientY: 53 });
    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  test("the click that ends a drag is swallowed, so a drag that ends over a link does not follow it", async () => {
    const onDrag = await watch();
    pointer("pointerdown", stage, { clientX: 10, clientY: 10 });
    pointer("pointermove", stage, { clientX: 40, clientY: 10 });
    pointer("pointerup", link, { clientX: 40, clientY: 10 });
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(clickReaches()).toBe(false);
    // Only that one click: the next is a real tap.
    expect(clickReaches()).toBe(true);
  });

  test("the pointerdown the layer hands to drauu mid-drag does not make the watcher forget the drag, so its click is still swallowed", async () => {
    const onDrag = await watch();
    pointer("pointerdown", link, { clientX: 10, clientY: 10 });
    pointer("pointermove", link, { clientX: 40, clientY: 10 });
    expect(onDrag).toHaveBeenCalledTimes(1);
    // The same pen's pointerdown again, with no pointerup between: not a new touch of the glass.
    pointer("pointerdown", stage, { clientX: 10, clientY: 10 });
    pointer("pointermove", link, { clientX: 60, clientY: 10 });
    pointer("pointerup", link, { clientX: 10, clientY: 10 });
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(clickReaches()).toBe(false);
  });

  test("a click outside the stage still fires after a pen drag, so an export download or a button press is not lost", async () => {
    // iPadOS sends no click after a Pencil drag, so the armed window stays
    // open for 500 ms; a programmatic click or a keyboard press in it is not
    // the pen's click.
    await watch();
    const button = document.createElement("button");
    outside.append(button);
    const onClick = vi.fn<() => void>();
    button.addEventListener("click", onClick);
    pointer("pointerdown", stage, { clientX: 10, clientY: 10 });
    pointer("pointermove", stage, { clientX: 40, clientY: 10 });
    pointer("pointerup", stage, { clientX: 40, clientY: 10 });
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("a click with no pointer behind it (detail 0: Enter, Space, a script) on the stage fires after a pen drag", async () => {
    await watch();
    pointer("pointerdown", stage, { clientX: 10, clientY: 10 });
    pointer("pointermove", stage, { clientX: 40, clientY: 10 });
    pointer("pointerup", stage, { clientX: 40, clientY: 10 });
    expect(clickReaches(0)).toBe(true);
    // That click was not the pen's, so the pen's own is still swallowed.
    expect(clickReaches()).toBe(false);
  });

  test("the next pointerdown disarms the swallowed click, so a later tap is not eaten", async () => {
    await watch();
    pointer("pointerdown", stage, { clientX: 10, clientY: 10 });
    pointer("pointermove", stage, { clientX: 40, clientY: 10 });
    pointer("pointerup", stage, { clientX: 40, clientY: 10 });
    pointer("pointerdown", link, { pointerType: "mouse", pointerId: 2, clientX: 1, clientY: 1 });
    expect(clickReaches()).toBe(true);
  });

  test("500 ms after the pen lifts the swallowed click is disarmed, because no click is coming", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await watch();
    pointer("pointerdown", stage, { clientX: 10, clientY: 10 });
    pointer("pointermove", stage, { clientX: 40, clientY: 10 });
    pointer("pointerup", stage, { clientX: 40, clientY: 10 });
    vi.advanceTimersByTime(499);
    expect(clickReaches()).toBe(false);
    pointer("pointerdown", stage, { clientX: 10, clientY: 10 });
    pointer("pointermove", stage, { clientX: 40, clientY: 10 });
    pointer("pointerup", stage, { clientX: 40, clientY: 10 });
    vi.advanceTimersByTime(500);
    expect(clickReaches()).toBe(true);
  });

  test("a cancelled pen drag arms nothing, because the browser sends no click after pointercancel", async () => {
    const onDrag = await watch();
    pointer("pointerdown", stage, { clientX: 10, clientY: 10 });
    pointer("pointermove", stage, { clientX: 40, clientY: 10 });
    pointer("pointercancel", stage, { clientX: 40, clientY: 10 });
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(clickReaches()).toBe(true);
  });

  test.each(["mouse", "touch"])(
    "a %s drag never calls onDrag, so only a pen is promoted",
    async (pointerType) => {
      const onDrag = await watch();
      pointer("pointerdown", link, { pointerType, clientX: 10, clientY: 10 });
      pointer("pointermove", link, { pointerType, clientX: 90, clientY: 10 });
      pointer("pointerup", link, { pointerType, clientX: 90, clientY: 10 });
      expect(onDrag).not.toHaveBeenCalled();
      expect(clickReaches()).toBe(true);
    },
  );

  test("enabled() false calls nothing and swallows nothing, so a chosen tool keeps its own drawing", async () => {
    const onDrag = await watch(() => false);
    pointer("pointerdown", link, { clientX: 10, clientY: 10 });
    pointer("pointermove", link, { clientX: 90, clientY: 10 });
    pointer("pointerup", link, { clientX: 90, clientY: 10 });
    expect(onDrag).not.toHaveBeenCalled();
    expect(clickReaches()).toBe(true);
  });

  test("a pen button other than contact starts nothing, so the barrel and eraser buttons do not draw", async () => {
    const onDrag = await watch();
    pointer("pointerdown", link, { button: 2, buttons: 2, clientX: 10, clientY: 10 });
    pointer("pointermove", link, { buttons: 2, clientX: 90, clientY: 10 });
    expect(onDrag).not.toHaveBeenCalled();
  });

  test("a second pen pointer is ignored, so only the primary pen draws", async () => {
    const onDrag = await watch();
    pointer("pointerdown", link, { pointerId: 7, isPrimary: false, clientX: 10, clientY: 10 });
    pointer("pointermove", link, { pointerId: 7, isPrimary: false, clientX: 90, clientY: 10 });
    expect(onDrag).not.toHaveBeenCalled();
  });

  test("moves of another pointer do not promote the tracked one", async () => {
    const onDrag = await watch();
    pointer("pointerdown", link, { pointerId: 1, clientX: 10, clientY: 10 });
    pointer("pointermove", link, { pointerId: 2, clientX: 90, clientY: 10 });
    expect(onDrag).not.toHaveBeenCalled();
  });

  test("a link's native drag is cancelled while a pen is down on the stage, so a stroke that starts on a link is not turned into a drag and drop", async () => {
    await watch();
    pointer("pointerdown", link, { clientX: 50, clientY: 50 });
    const drag = new DragEvent("dragstart", { bubbles: true, cancelable: true });
    link.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
  });

  test("a native drag is left alone with no pen down, for a mouse, and when enabled() is false", async () => {
    let on = true;
    await watch(() => on);
    const dragstart = () => {
      const event = new DragEvent("dragstart", { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(dragstart()).toBe(false);
    pointer("pointerdown", link, { pointerType: "mouse", clientX: 50, clientY: 50 });
    expect(dragstart()).toBe(false);
    pointer("pointerup", link, { pointerType: "mouse" });
    on = false;
    pointer("pointerdown", link, { clientX: 50, clientY: 50 });
    expect(dragstart()).toBe(false);
  });

  test("once the pen lifts a native drag is left alone again", async () => {
    await watch();
    pointer("pointerdown", link, { clientX: 50, clientY: 50 });
    pointer("pointerup", link, { clientX: 50, clientY: 50 });
    const drag = new DragEvent("dragstart", { bubbles: true, cancelable: true });
    link.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(false);
  });

  test("a pen down outside the stage is not watched", async () => {
    const onDrag = await watch();
    pointer("pointerdown", outside, { clientX: 10, clientY: 10 });
    pointer("pointermove", outside, { clientX: 90, clientY: 10 });
    expect(onDrag).not.toHaveBeenCalled();
  });

  test("the disposer removes every listener", async () => {
    const { watchPenDrags } = await load();
    const onDrag = vi.fn<(down: PointerEvent) => void>();
    const dispose = watchPenDrags(stage, { enabled: () => true, onDrag });
    dispose();
    pointer("pointerdown", link, { clientX: 10, clientY: 10 });
    pointer("pointermove", link, { clientX: 90, clientY: 10 });
    expect(onDrag).not.toHaveBeenCalled();
  });
});

describe("the pen latch", () => {
  test("the first pen pointerdown inside the stage marks a pen in use, and a mouse or touch does not", async () => {
    const { notePenOn, penInUse } = await load();
    disposers.push(notePenOn(stage));
    expect(penInUse()).toBe(false);
    pointer("pointerdown", link, { pointerType: "mouse", pointerId: 2 });
    pointer("pointerdown", link, { pointerType: "touch", pointerId: 3 });
    expect(penInUse()).toBe(false);
    pointer("pointerdown", link, { pointerType: "pen" });
    expect(penInUse()).toBe(true);
  });

  test("a pen outside the stage does not flip it", async () => {
    const { notePenOn, penInUse } = await load();
    disposers.push(notePenOn(stage));
    pointer("pointerdown", outside, { pointerType: "pen" });
    expect(penInUse()).toBe(false);
  });

  test("hovering does not flip it, because only a touch of the glass is a pen in use", async () => {
    const { notePenOn, penInUse } = await load();
    disposers.push(notePenOn(stage));
    pointer("pointermove", link, { pointerType: "pen", buttons: 0 });
    expect(penInUse()).toBe(false);
  });

  test("subscribers hear the flip once, however many pens follow", async () => {
    const { notePenOn, subscribePenInUse } = await load();
    const listener = vi.fn<() => void>();
    disposers.push(subscribePenInUse(listener));
    disposers.push(notePenOn(stage));
    pointer("pointerdown", link, { pointerType: "pen" });
    pointer("pointerdown", link, { pointerType: "pen" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("the latch outlives the watcher: a pen in use stays in use until the page reloads", async () => {
    const { notePenOn, penInUse } = await load();
    const dispose = notePenOn(stage);
    pointer("pointerdown", link, { pointerType: "pen" });
    dispose();
    expect(penInUse()).toBe(true);
  });
});

describe("the setting", () => {
  test("it is on by default, so a stylus draws without a trip to the menu", async () => {
    const { stylusDraws } = await load();
    expect(stylusDraws()).toBe(true);
  });

  test("turning it off is stored under docwalk.stylusAsMouse and read back by the next page load", async () => {
    const first = await load();
    first.setStylusDraws(false);
    expect(first.stylusDraws()).toBe(false);
    expect(localStorage.getItem("docwalk.stylusAsMouse")).toBe("true");
    const second = await load();
    expect(second.stylusDraws()).toBe(false);
    second.setStylusDraws(true);
    expect(localStorage.getItem("docwalk.stylusAsMouse")).toBeNull();
  });

  test("a localStorage that throws leaves it on, and a change still applies for this visit", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const { stylusDraws, setStylusDraws } = await load();
    expect(stylusDraws()).toBe(true);
    expect(() => setStylusDraws(false)).not.toThrow();
    expect(stylusDraws()).toBe(false);
  });

  test("subscribers hear a change, and only a change", async () => {
    const { setStylusDraws, subscribeStylusDraws } = await load();
    const listener = vi.fn<() => void>();
    disposers.push(subscribeStylusDraws(listener));
    setStylusDraws(false);
    setStylusDraws(false);
    setStylusDraws(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
