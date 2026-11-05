import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { SlideInfo } from "../deck/controller";
import { Outline } from "./Outline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const slide = (index: number, sectionId: string, page: number): SlideInfo => ({
  index,
  address: `${sectionId}/${page}`,
  sectionId,
  page,
  title: sectionId,
  flagged: false,
  note: null,
});

// "intro" has one page; "failure" has three and the presenter is on its third.
const SLIDES = [
  slide(0, "intro", 1),
  slide(1, "failure", 1),
  slide(2, "failure", 2),
  slide(3, "failure", 3),
];

function render(current: SlideInfo, onSelect: (address: string) => void) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(h(Outline, { slides: SLIDES, current, onSelect })));
  return container;
}

const option = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
    o.textContent?.startsWith(name),
  )!;

describe("outline", () => {
  test("clicking another section goes to its first page", async () => {
    const onSelect = vi.fn<(address: string) => void>();
    const el = render(SLIDES[3]!, onSelect);
    await userEvent.click(option(el, "intro"));
    expect(onSelect).toHaveBeenCalledWith("intro/1");
  });

  // A presenter on page 3 of a section clicks that section to restart it. React
  // Aria toggles the already-selected key off, so the click arrives as an empty
  // selection; it must still navigate, or the outline looks broken.
  test("clicking the current section returns to its first page", async () => {
    const onSelect = vi.fn<(address: string) => void>();
    const el = render(SLIDES[3]!, onSelect);
    const failure = option(el, "failure");
    expect(failure.getAttribute("aria-selected")).toBe("true");
    await userEvent.click(failure);
    expect(onSelect).toHaveBeenCalledWith("failure/1");
  });

  test("Enter on the current section does the same, for keyboard users", async () => {
    const onSelect = vi.fn<(address: string) => void>();
    const el = render(SLIDES[3]!, onSelect);
    act(() => option(el, "failure").focus());
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("failure/1");
  });
});
