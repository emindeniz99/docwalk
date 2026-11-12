import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { DeckController } from "../deck/controller";
import { Deck } from "../deck/Deck";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { coverPage } from "./boardCover";
import { createAnnotationLayer } from "./layer";
import type { AnnotationLayer } from "./types";

/**
 * While a whiteboard is open the page under it must not take keyboard focus:
 * Tab would land on a link nobody can see (WCAG 2.4.11, decision 110).
 * reveal.js marks every other slide `inert` itself, so the cover has to put
 * back only what it set, and only on the page it set it on.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let layer: AnnotationLayer | null = null;

afterEach(() => {
  layer?.destroy();
  layer = null;
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

/** The deck's DOM: a control before the stage, `.reveal > .slides` with two pages, a control after. */
function deck() {
  const before = document.createElement("button");
  before.textContent = "before";
  const reveal = document.createElement("div");
  reveal.className = "reveal";
  reveal.tabIndex = 0;
  const stage = document.createElement("div");
  stage.className = "slides";
  stage.innerHTML = `
    <section class="present" data-docwalk-id="a" data-page="1"><a href="#x">first link</a><a href="#y">second link</a></section>
    <section data-docwalk-id="a" data-page="2" inert><a href="#z">hidden link</a></section>`;
  reveal.append(stage);
  const after = document.createElement("button");
  after.textContent = "after";
  document.body.append(before, reveal, after);
  const [page, other] = [...stage.querySelectorAll("section")] as [HTMLElement, HTMLElement];
  return { before, reveal, stage, after, page, other };
}

describe("coverPage", () => {
  test("Tab from before the stage never reaches a link on the covered page, so a keyboard user cannot land on what the board hides", async () => {
    const { before, page, after } = deck();
    coverPage(document.querySelector<HTMLElement>(".slides")!);
    before.focus();
    const visited: Element[] = [];
    for (let i = 0; i < 4; i++) {
      await userEvent.tab();
      visited.push(document.activeElement!);
    }
    expect(visited.some((el) => page.contains(el))).toBe(false);
    expect(visited).toContain(after);
  });

  test("a focused link inside the page loses focus to .reveal, so Tab and the keys start from the deck again", () => {
    const { page, reveal, stage } = deck();
    const link = page.querySelector("a")!;
    link.focus();
    expect(document.activeElement).toBe(link);
    coverPage(stage);
    expect(document.activeElement).toBe(reveal);
  });

  test("focus outside the page stays where it is", () => {
    const { before, stage } = deck();
    before.focus();
    coverPage(stage);
    expect(document.activeElement).toBe(before);
  });

  test("undo makes the page tabbable again when the cover set inert", () => {
    const { page, stage } = deck();
    const uncover = coverPage(stage);
    expect(page.inert).toBe(true);
    uncover();
    expect(page.inert).toBe(false);
  });

  test("undo after the page lost `present` leaves inert on, because reveal.js owns it on every other slide", () => {
    const { page, stage } = deck();
    const uncover = coverPage(stage);
    // The slide changed: reveal.js drops `present` and marks the page inert.
    page.classList.remove("present");
    page.setAttribute("inert", "");
    uncover();
    expect(page.inert).toBe(true);
  });

  test("undo on a page that was inert already leaves it inert, so the cover never removes what it did not set", () => {
    const { page, stage } = deck();
    page.inert = true;
    const uncover = coverPage(stage);
    uncover();
    expect(page.inert).toBe(true);
  });

  test("the other pages are left as reveal.js has them", () => {
    const { other, stage } = deck();
    const uncover = coverPage(stage);
    expect(other.inert).toBe(true);
    uncover();
    expect(other.inert).toBe(true);
  });

  test("a stage with no current page is left alone and undo does nothing", () => {
    const { page, stage } = deck();
    page.classList.remove("present");
    const uncover = coverPage(stage);
    expect(page.inert).toBe(false);
    expect(() => uncover()).not.toThrow();
    expect(page.inert).toBe(false);
  });

  test("an overlay child of the stage is not the page: only `:scope > section.present` is covered", () => {
    const { stage, page } = deck();
    const overlay = document.createElement("div");
    overlay.className = "docwalk-annotate";
    const nested = document.createElement("section");
    nested.className = "present";
    overlay.append(nested);
    stage.append(overlay);
    coverPage(stage);
    expect(page.inert).toBe(true);
    expect(nested.inert).toBe(false);
    expect(overlay.inert).toBe(false);
  });
});

/** A reveal.js deck of two slides, the first with a link, and its controller once it is up. */
async function realDeck(): Promise<DeckController> {
  const container = document.createElement("div");
  Object.assign(container.style, { display: "grid", width: "1280px", height: "800px" });
  document.body.append(container);
  root = createRoot(container);
  let ready: DeckController | null = null;
  const plan = sectionize(parseMarkdown("## One\n\n[A link](#two)\n\n## Two\n\nBeta.\n"), "auto");
  act(() =>
    root!.render(
      h(Deck, {
        plan,
        onReady: (c: DeckController | null) => {
          if (c) ready = c;
        },
      }),
    ),
  );
  await expect.poll(() => ready, { timeout: 20_000, interval: 10 }).not.toBeNull();
  return ready!;
}

describe("the cover on a real deck (decision 110)", () => {
  test("asking for the slide already on screen keeps the page under an open board inert", async () => {
    // reveal.js updates every slide's `inert` on any slide(), the same index too, and fires no
    // slidechanged then: the board stays open over a page whose links Tab could reach again.
    const controller = await realDeck();
    const stage = controller.stage();
    const current = controller.current()!;
    layer = createAnnotationLayer(stage);
    layer.setKey(`${current.address}#x`, current.address);
    layer.setBoard({ key: "one/board#0", address: "one/board" });
    const page = stage.querySelector<HTMLElement>(":scope > section.present")!;
    expect(page.inert).toBe(true);

    expect(controller.goTo(current.address)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(layer.board()).toBe("one/board");
    expect(page.classList.contains("present")).toBe(true);
    expect(page.inert).toBe(true);

    // Closing the board still gives the page back.
    layer.setBoard(null);
    expect(page.inert).toBe(false);
  });
});
