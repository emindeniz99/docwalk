import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { SlideOverview } from "./SlideOverview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("slide overview", () => {
  // A new user with an empty or heading-free document presses O and got a
  // large empty dialog with keyboard hints for a grid that does not exist.
  // It says what the preview and Present say: what to do to get a slide.
  test("an empty deck says how to make a slide instead of offering arrow keys", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        h(SlideOverview, {
          isOpen: true,
          onOpenChange: () => {},
          controller: null,
          current: null,
          onGoTo: () => {},
        }),
      ),
    );
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeTruthy();
    const text = document.querySelector('[role="dialog"]')!.textContent ?? "";
    expect(text).toContain("Nothing to show yet. Add text under a heading to make a slide.");
    expect(text).not.toContain("Arrow keys");
    expect(document.querySelector('[role="grid"]')).toBeNull();
  });
});
