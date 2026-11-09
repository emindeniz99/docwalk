import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
// Same fonts as the app, so heights match what readers see.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { MATH_DISPLAY_CLASS } from "../render/math";
import { parseMarkdown } from "../sectioning/sectionize";
import { DocumentView, type DocumentTarget } from "./DocumentView";

/**
 * Decision 101 in document mode. The reading view draws formulas and
 * shortcodes as the slides do; a formula changes the height of what is
 * above a heading, so a linked heading waits for it; and a display
 * equation wider than the page scrolls inside itself, so a keyboard user
 * needs a tab stop on it (WCAG 2.1.1).
 */

let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
});

interface Mounted {
  pane: HTMLElement;
  article: HTMLElement;
}

/** The reading view in a scrolling pane, once it reports its content drawn. */
async function mount(
  markdown: string,
  scrollTarget: DocumentTarget | null = null,
): Promise<Mounted> {
  const pane = document.createElement("div");
  pane.className = "docwalk-document-pane";
  Object.assign(pane.style, { width: "1000px", height: "600px" });
  document.body.append(pane);
  root = createRoot(pane);
  let drawn = 0;
  root.render(
    h(DocumentView, {
      root: parseMarkdown(markdown),
      scrollTarget,
      onRendered: () => {
        drawn++;
      },
    }),
  );
  await expect.poll(() => drawn, { timeout: 20_000 }).toBeGreaterThan(0);
  return { pane, article: pane.querySelector<HTMLElement>(".docwalk-document")! };
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

// First in this file on purpose: Temml is not loaded yet, so its chunk
// arrives after the view's first layout, as it does over a network.
describe("a display equation wider than the page", () => {
  test("takes a tab stop once drawn, even when drawing it resizes nothing", async () => {
    // Sixty terms in one row. The article keeps a fixed height, as it does
    // when the drawn equation is as tall as its source block, so no resize
    // happens after the formula is drawn.
    const terms = Array.from({ length: 60 }, (_, i) => `a_{${i}}`).join(" + ");
    const style = document.createElement("style");
    style.textContent = ".docwalk-document { height: 2000px; }";
    document.head.append(style);
    try {
      const { article } = await mount(`Short $x$ formula.\n\n$$\n${terms}\n$$\n`);
      const host = article.querySelector<HTMLElement>(`.${MATH_DISPLAY_CLASS}`)!;
      expect(host.scrollWidth).toBeGreaterThan(host.clientWidth);
      await frame();
      await frame();
      expect(host.tabIndex).toBe(0);
    } finally {
      style.remove();
    }
  });
});

describe("formulas and shortcodes in the reading view", () => {
  test("are drawn as MathML and characters, in all four forms", async () => {
    const { article } = await mount(
      [
        "Ship it :rocket: once $E = mc^2$ and $`a_b`$ hold.",
        "",
        "$$",
        "\\frac{1}{2}",
        "$$",
        "",
        "```math",
        "\\sqrt{x}",
        "```",
        "",
      ].join("\n"),
    );
    expect(article.querySelector("p")!.textContent).toBe("Ship it 🚀 once E=mc2 and ab hold.");
    expect(article.querySelectorAll("p > math")).toHaveLength(2);
    const hosts = article.querySelectorAll(`.${MATH_DISPLAY_CLASS} > math[display=block]`);
    expect(hosts).toHaveLength(2);
    expect(article.querySelector("code.language-math, pre")).toBeNull();
  });

  test("a linked heading below formulas is at the top once they are drawn", async () => {
    // Drawn, each equation is taller than its one-line source: a scroll
    // made before they are drawn would leave the heading below the top.
    // Chromium's scroll anchoring would hide that; WebKit has none, so the
    // pane turns it off.
    const style = document.createElement("style");
    style.textContent = ".docwalk-document-pane { overflow-anchor: none; }";
    document.head.append(style);
    const equations = Array.from(
      { length: 20 },
      (_, i) => `$$\n\\sum_{k=1}^{${i + 2}} \\frac{x_k}{1 + y_k}\n$$`,
    );
    const markdown = `# Doc\n\n${equations.join("\n\n")}\n\n## Target\n\nHere.\n\n${"Filler.\n\n".repeat(40)}`;
    const { pane, article } = await mount(markdown, { anchor: "target" });
    await frame();
    style.remove();
    const heading = article.querySelector("h2")!;
    const margin = Number.parseFloat(getComputedStyle(heading).scrollMarginTop);
    const offset = heading.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    expect(pane.scrollTop).toBeGreaterThan(0);
    expect(Math.abs(offset - margin)).toBeLessThanOrEqual(2);
  });
});
