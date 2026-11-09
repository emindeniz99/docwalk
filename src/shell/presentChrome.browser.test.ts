import { createElement as h, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { CHROME_IDLE_MS, usePresentChrome } from "./presentChrome";

/**
 * Tab and Shift+Tab from the slide into the hidden present bar (decision 75).
 * The bar comes before the deck in the DOM, so the hook has to hand focus to
 * a control a keyboard user can see. The annotation toolbar hides some of its
 * controls when it is narrow (a container query puts them in a More tools
 * menu), and a hidden control takes no focus: landing on one leaves the user
 * looking at nothing (WCAG 2.4.3, 2.4.7). These tests hide controls by CSS in
 * a real browser, because jsdom has no layout to say what is visible.
 */

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function Harness({ bar, pane }: { bar: string; pane: RefObject<HTMLDivElement | null> }) {
  usePresentChrome({ active: true, pane, slideOwner: () => false });
  return h("div", {
    ref: pane,
    "data-testid": "pane",
    dangerouslySetInnerHTML: {
      __html: `<div class="docwalk-preview-head">${bar}</div>
        <div class="reveal" tabindex="0" id="slide">slide</div>`,
    },
  });
}

/** Mount the harness, let the idle timer hide the chrome, and put focus on the slide. */
async function mount(bar: string) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(h(Harness, { bar, pane: createRef<HTMLDivElement>() })));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CHROME_IDLE_MS + 100);
  });
  vi.useRealTimers();
  const slide = document.getElementById("slide")!;
  slide.focus();
  expect(document.activeElement).toBe(slide);
}

const focusedLabel = () => document.activeElement?.getAttribute("aria-label") ?? "";

describe("Tab into the hidden present bar lands on a visible control", () => {
  test("Shift+Tab skips a last control hidden by display: none", async () => {
    // The shape of the annotation toolbar when narrow: the controls the container query
    // folds into the More tools menu sit after the visible ones in the DOM.
    await mount(`
      <button aria-label="Overview">Overview</button>
      <button aria-label="Pen">Pen</button>
      <button aria-label="Clear marks" style="display: none">Clear</button>`);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(focusedLabel()).toBe("Pen");
  });

  test("Shift+Tab skips a last control inside a hidden wrapper", async () => {
    await mount(`
      <button aria-label="Overview">Overview</button>
      <button aria-label="Pen">Pen</button>
      <div style="display: none"><button aria-label="Ellipse">Ellipse</button></div>
      <div style="visibility: hidden"><button aria-label="Rectangle">Rectangle</button></div>`);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(focusedLabel()).toBe("Pen");
  });

  test("Shift+Tab skips a last control inside an inert subtree", async () => {
    await mount(`
      <button aria-label="Overview">Overview</button>
      <button aria-label="Pen">Pen</button>
      <div inert><button aria-label="Whiteboard">Whiteboard</button></div>`);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(focusedLabel()).toBe("Pen");
  });

  test("Tab skips a first control hidden by display: none", async () => {
    await mount(`
      <button aria-label="Overview" style="display: none">Overview</button>
      <button aria-label="Pen">Pen</button>
      <button aria-label="Clear marks">Clear</button>`);
    await userEvent.keyboard("{Tab}");
    expect(focusedLabel()).toBe("Pen");
  });

  test("the last visible control still wins when nothing is hidden", async () => {
    await mount(`
      <button aria-label="Overview">Overview</button>
      <button aria-label="Clear marks">Clear</button>`);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(focusedLabel()).toBe("Clear marks");
  });
});
