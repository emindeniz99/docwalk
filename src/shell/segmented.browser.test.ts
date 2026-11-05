import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
});

/** The header's Edit/Document toggle, as App renders it. */
function render() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      h(
        ToggleButtonGroup,
        {
          "aria-label": "View",
          selectionMode: "single",
          disallowEmptySelection: true,
          defaultSelectedKeys: ["edit"],
          className: "docwalk-segmented",
        },
        h(ToggleButton, { id: "edit" }, "Edit"),
        h(ToggleButton, { id: "document" }, "Document"),
      ),
    ),
  );
  return container;
}

describe("segmented view toggle", () => {
  for (const theme of ["light", "dark"] as const) {
    // Every other header control answers the pointer; without a hover state the
    // unselected segment looked inert until clicked.
    test(`the unselected segment reacts to hover (${theme})`, async () => {
      document.documentElement.dataset.theme = theme;
      const el = render();
      const doc = [...el.querySelectorAll("button")].find((b) => b.textContent === "Document")!;
      const before = getComputedStyle(doc).backgroundColor;
      await userEvent.hover(doc);
      expect(doc.hasAttribute("data-hovered")).toBe(true);
      await expect.poll(() => getComputedStyle(doc).backgroundColor).not.toBe(before);
    });
  }
});
