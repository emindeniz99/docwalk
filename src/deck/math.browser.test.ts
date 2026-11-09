import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
// Same fonts as the app, so measurements and pagination match what users see.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { MATH_DISPLAY_CLASS } from "../render/math";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import type { DeckController } from "./controller";
import { Deck, type DeckReport } from "./Deck";

/**
 * Decision 101 with rules 3 and 4. A formula drawn as MathML is not the
 * size of its TeX, so the deck must draw every formula before it measures
 * and cuts pages; and a display equation scrolls inside its own block, so
 * one wider than the slide must be measured on its own and reported.
 */

let root: Root | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
});

interface Built {
  container: HTMLElement;
  controller: DeckController;
  report: DeckReport;
}

/** The real Deck, as App mounts it, once it has paginated and reported. */
async function mountDeck(markdown: string): Promise<Built> {
  const container = document.createElement("div");
  Object.assign(container.style, { display: "grid", width: "1280px", height: "800px" });
  document.body.append(container);
  root = createRoot(container);
  let controller: DeckController | null = null;
  let report: DeckReport | null = null;
  root.render(
    h(Deck, {
      plan: sectionize(parseMarkdown(markdown), "auto"),
      onReady: (c: DeckController | null) => {
        controller = c;
      },
      onReport: (r: DeckReport) => {
        report = r;
      },
    }),
  );
  await expect.poll(() => controller, { timeout: 20_000 }).not.toBeNull();
  return { container, controller: controller!, report: report! };
}

const pagesOf = (container: HTMLElement, id: string) => [
  ...container.querySelectorAll<HTMLElement>(`.reveal .slides > section[data-docwalk-id='${id}']`),
];

// Each one distinct, so a page that repeated or dropped one would show.
const EQUATIONS = Array.from(
  { length: 14 },
  (_, i) => `$$\n\\sum_{k=1}^{${i + 2}} \\frac{x_k^{${i}}}{1 + y_k}\n$$`,
);

const MANY = [
  "## Intro",
  "",
  "Ship it :rocket: once $E = mc^2$ holds.",
  "",
  "## Proofs",
  "",
  EQUATIONS.join("\n\n"),
  "",
].join("\n");

describe("formulas are drawn before the deck measures (rule 4)", () => {
  test("many display equations paginate whole, each once, and no page is flagged", async () => {
    const { container, controller, report } = await mountDeck(MANY);
    // Pagination copies the slides it measured: a formula drawn later would
    // still be TeX in these copies.
    expect(container.querySelectorAll(".reveal .slides code.language-math")).toHaveLength(0);
    const pages = pagesOf(container, "proofs");
    expect(pages.length).toBeGreaterThan(1);
    const hosts = pages.flatMap((page) => [...page.querySelectorAll(`.${MATH_DISPLAY_CLASS}`)]);
    expect(
      hosts.map((host) => [host.childElementCount, host.firstElementChild?.localName]),
    ).toEqual(EQUATIONS.map(() => [1, "math"]));
    expect(new Set(hosts.map((host) => host.textContent)).size).toBe(EQUATIONS.length);
    expect(controller.slides().filter((s) => s.flagged)).toEqual([]);
    expect(report.overflowing).toEqual([]);
  });

  test("an inline formula and a shortcode are drawn in the slide's text", async () => {
    const { container } = await mountDeck(MANY);
    const [intro] = pagesOf(container, "intro");
    expect(intro!.querySelector("p > math msup")).not.toBeNull();
    expect(intro!.querySelector("p")!.textContent).toBe("Ship it 🚀 once E=mc2 holds.");
  });
});

describe("an equation wider than the slide (rule 3)", () => {
  // Sixty terms in one row: MathML does not break a display equation, so
  // its block scrolls sideways while the slide body itself fits.
  const terms = Array.from({ length: 60 }, (_, i) => `a_{${i}}`).join(" + ");
  const WIDE = `## Wide\n\n$$\n${terms}\n$$\n`;

  test("is reported as an equation too wide, not clipped inside its block", async () => {
    const { container, report } = await mountDeck(WIDE);
    const [page] = pagesOf(container, "wide");
    expect(page!.querySelector(`.${MATH_DISPLAY_CLASS} > math`)).not.toBeNull();
    expect(report.overflowing.map((o) => o.id)).toEqual(["wide/1"]);
    const m = report.overflowing[0]!.measurement;
    expect(m.body.x).toBe(0); // the body alone would pass this slide
    expect(m.math[0]!.x).toBeGreaterThan(500);
    const note = page!.querySelector<HTMLElement>(".docwalk-overflow")!;
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain("1 equation too wide");
  });

  test("an equation that fits raises no note", async () => {
    const { container, report } = await mountDeck("## Fits\n\n$$\na + b = c\n$$\n");
    expect(report.overflowing).toEqual([]);
    const [page] = pagesOf(container, "fits");
    expect(page!.querySelector<HTMLElement>(".docwalk-overflow")!.hidden).toBe(true);
  });
});
