import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import type { FocusEvent } from "../annotate/mirrorTypes";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import type { DeckController } from "./controller";
import { Deck } from "./Deck";
import { openMirroredFocus } from "./focus";
import { observeFocus } from "./focusEvents";

/**
 * The diagram tour in the diagram focus view (decision 109). `diagramTour`
 * draws a step and `tourModel` decides it; these tests are about the view
 * around them: which keys step, end and start the tour, that Escape works in
 * layers (the first ends the tour, the second closes the view), that a tap on a
 * node picks it and a drag that pans does not, which buttons Tab can reach,
 * what the mirror hears, and that no key reaches the deck behind the view.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let stopObserving: (() => void) | null = null;

afterEach(() => {
  stopObserving?.();
  stopObserving = null;
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const FLOW =
  "## Diagram\n\n```mermaid\nflowchart LR\n  a[Alpha] --> b[Beta]\n  b --> c[Gamma]\n```\n\n## Next\n\nMore text.\n\n## Last\n\nEnd.\n";
const SEQUENCE =
  "## Diagram\n\n```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi\n```\n\n## Next\n\nMore text.\n";
const SINGLE = "## Diagram\n\n```mermaid\nflowchart LR\n  a[Alone]\n```\n\n## Next\n\nMore.\n";

function mountDeck(markdown: string) {
  const container = document.createElement("div");
  Object.assign(container.style, { display: "grid", width: "1280px", height: "800px" });
  document.body.append(container);
  root = createRoot(container);
  const readies: DeckController[] = [];
  const onReady = (c: DeckController | null) => {
    if (c) readies.push(c);
  };
  act(() => root!.render(h(Deck, { plan: sectionize(parseMarkdown(markdown), "auto"), onReady })));
  const ready = async () => {
    await expect.poll(() => readies.length, { timeout: 20_000, interval: 10 }).toBeGreaterThan(0);
  };
  return { container, ready, readies };
}

const view = () => document.querySelector<HTMLElement>(".docwalk-focus");
const button = (label: string) =>
  view()?.querySelector<HTMLButtonElement>(`.docwalk-focus-toolbar [aria-label="${label}"]`) ??
  null;
const tourButton = () => button("Tour");
const back = () => button("Previous step");
const next = () => button("Next node");
const countText = () => view()?.querySelector(".docwalk-tour-count")?.textContent ?? "";
const statusText = () => view()?.querySelector(".docwalk-tour-status")?.textContent ?? "";
const rings = () => [...(view()?.querySelectorAll(".docwalk-tour-ring") ?? [])];
const nodes = () => [...(view()?.querySelectorAll<SVGGElement>("svg g.node") ?? [])];

/** The label of the node the solid ring surrounds, or null. */
function ringed(): string | null {
  const [ring] = rings();
  if (!ring) return null;
  const outer = ring.getBoundingClientRect();
  const inside = nodes().filter((node) => {
    const box = node.getBoundingClientRect();
    return (
      box.left >= outer.left - 1 &&
      box.right <= outer.right + 1 &&
      box.top >= outer.top - 1 &&
      box.bottom <= outer.bottom + 1
    );
  });
  return inside.length === 1 ? (inside[0]!.textContent ?? "").trim() : null;
}

function record() {
  const events: FocusEvent[] = [];
  stopObserving = observeFocus((event) => events.push(event));
  return events;
}
const tours = (events: FocusEvent[]) =>
  events.flatMap((event) => (event.kind === "tour" ? [[...event.path]] : []));

async function openView(markdown = FLOW) {
  const deck = mountDeck(markdown);
  await deck.ready();
  const diagram = deck.container.querySelector<HTMLElement>(
    ".reveal .slides section.present .docwalk-diagram",
  )!;
  diagram.focus();
  await userEvent.keyboard("{Enter}");
  expect(view()).not.toBeNull();
  return deck;
}

async function startTour() {
  await userEvent.keyboard("t");
  await expect.poll(() => ringed()).toBe("Alpha");
}

describe("starting and ending the tour", () => {
  test("T starts at node 1, moves focus to Next and shows the count", async () => {
    await openView();
    const events = record();
    expect(tourButton()!.getAttribute("aria-pressed")).toBe("false");
    await startTour();
    expect(tourButton()!.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(next());
    expect(countText()).toBe("1 / 3");
    expect(tours(events)).toEqual([[1]]);
  });

  test("the Tour button toggles, and ending it puts focus back on the button", async () => {
    await openView();
    const events = record();
    await userEvent.click(tourButton()!);
    await expect.poll(() => ringed()).toBe("Alpha");
    expect(document.activeElement).toBe(next());
    await userEvent.click(tourButton()!);
    await expect.poll(() => rings().length).toBe(0);
    expect(tourButton()!.getAttribute("aria-pressed")).toBe("false");
    expect(document.activeElement).toBe(tourButton());
    expect(tours(events)).toEqual([[1], []]);
  });

  test("Back, Next and the count are hidden and out of the tab order while the tour is off", async () => {
    await openView();
    for (const el of [back(), next()]) {
      expect(el!.hidden).toBe(true);
      expect(el!.disabled).toBe(true);
    }
    expect(view()!.querySelector<HTMLElement>(".docwalk-tour-count")!.hidden).toBe(true);
    await startTour();
    for (const el of [back(), next()]) {
      expect(el!.hidden).toBe(false);
      expect(el!.disabled).toBe(false);
    }
  });

  test("Escape ends a running tour and keeps the view; a second Escape closes the view", async () => {
    await openView();
    const events = record();
    await startTour();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => rings().length).toBe(0);
    expect(view()).not.toBeNull();
    expect(tours(events)).toEqual([[1], []]);
    expect(events.some((event) => event.kind === "close")).toBe(false);
    await userEvent.keyboard("{Escape}");
    expect(view()).toBeNull();
    expect(events.at(-1)?.kind).toBe("close");
  });

  test("T ends a running tour too", async () => {
    await openView();
    await startTour();
    await userEvent.keyboard("t");
    await expect.poll(() => rings().length).toBe(0);
    expect(view()).not.toBeNull();
    expect(document.activeElement).toBe(tourButton());
  });

  test("closing the view ends the tour: the next view starts without one", async () => {
    const deck = await openView();
    await startTour();
    await userEvent.keyboard("{Escape}{Escape}");
    expect(view()).toBeNull();
    deck.container
      .querySelector<HTMLElement>(".reveal .slides section.present .docwalk-diagram")!
      .focus();
    await userEvent.keyboard("{Enter}");
    expect(view()).not.toBeNull();
    expect(rings().length).toBe(0);
    expect(tourButton()!.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("stepping", () => {
  test("ArrowRight, ArrowDown and PageDown go to the next node; Next stops at the last", async () => {
    await openView();
    const events = record();
    await startTour();
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(() => ringed()).toBe("Beta");
    await userEvent.keyboard("{PageDown}");
    await expect.poll(() => ringed()).toBe("Gamma");
    expect(countText()).toBe("3 / 3");
    expect(next()!.getAttribute("aria-disabled")).toBe("true");
    // Nothing further: no new path is sent and focus stays where it was.
    const before = tours(events).length;
    await userEvent.keyboard("{ArrowDown}");
    // Playwright will not click an aria-disabled control, so call the handler as a script would.
    next()!.click();
    expect(tours(events).length).toBe(before);
    expect(ringed()).toBe("Gamma");
    expect(document.activeElement).toBe(next());
    expect(tours(events)).toEqual([[1], [1, 2], [1, 2, 3]]);
  });

  test("Space steps when focus is on the view, and is the button's own on a toolbar button", async () => {
    await openView();
    const events = record();
    await startTour();
    // Focus is on Next after the start: Space activates that button, once.
    await userEvent.keyboard(" ");
    await expect.poll(() => ringed()).toBe("Beta");
    expect(tours(events)).toEqual([[1], [1, 2]]);
    // Off a button the view takes Space as Next.
    view()!.focus();
    await userEvent.keyboard(" ");
    await expect.poll(() => ringed()).toBe("Gamma");
    expect(tours(events)).toEqual([[1], [1, 2], [1, 2, 3]]);
  });

  test("ArrowLeft and PageUp go back one step; Back keeps the first", async () => {
    await openView();
    const events = record();
    await startTour();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await expect.poll(() => ringed()).toBe("Gamma");
    await userEvent.keyboard("{ArrowLeft}");
    await expect.poll(() => ringed()).toBe("Beta");
    await userEvent.keyboard("{PageUp}");
    await expect.poll(() => ringed()).toBe("Alpha");
    expect(back()!.getAttribute("aria-disabled")).toBe("true");
    await userEvent.keyboard("{ArrowUp}");
    expect(ringed()).toBe("Alpha");
    expect(tours(events)).toEqual([[1], [1, 2], [1, 2, 3], [1, 2], [1]]);
  });

  test("Home starts again at the first node", async () => {
    await openView();
    const events = record();
    await startTour();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await expect.poll(() => ringed()).toBe("Gamma");
    await userEvent.keyboard("{Home}");
    await expect.poll(() => ringed()).toBe("Alpha");
    expect(tours(events).at(-1)).toEqual([1]);
    expect(countText()).toBe("1 / 3");
  });

  test("Back and Next step, and a key with a modifier does not", async () => {
    await openView();
    const events = record();
    await startTour();
    await userEvent.click(next()!);
    await expect.poll(() => ringed()).toBe("Beta");
    await userEvent.click(back()!);
    await expect.poll(() => ringed()).toBe("Alpha");
    await userEvent.keyboard("{Control>}{ArrowRight}{/Control}");
    expect(ringed()).toBe("Alpha");
    expect(tours(events)).toEqual([[1], [1, 2], [1]]);
  });

  test("arrow keys do nothing to the tour while it is off, and none reaches the deck", async () => {
    const deck = await openView();
    const index = deck.readies.at(-1)!.current()!.index;
    const heard: string[] = [];
    const listen = (event: KeyboardEvent) => heard.push(event.key);
    window.addEventListener("keydown", listen);
    await userEvent.keyboard("{ArrowRight}");
    await startTour();
    await userEvent.keyboard("{ArrowRight}{PageDown}{Home}{ArrowLeft}");
    window.removeEventListener("keydown", listen);
    expect(heard).toEqual([]);
    await userEvent.keyboard("{Escape}{Escape}");
    expect(view()).toBeNull();
    expect(deck.readies.at(-1)!.current()!.index).toBe(index);
  });
});

describe("tapping a node", () => {
  test("a tap on a node moves the tour to it", async () => {
    await openView();
    const events = record();
    await startTour();
    const gamma = nodes().find((node) => node.textContent?.includes("Gamma"))!;
    await userEvent.click(gamma);
    await expect.poll(() => ringed()).toBe("Gamma");
    expect(tours(events)).toEqual([[1], [1, 3]]);
    expect(countText()).toBe("3 / 3");
  });

  test("a tap before the tour starts does not start it", async () => {
    await openView();
    const events = record();
    await userEvent.click(nodes()[1]!);
    expect(rings().length).toBe(0);
    expect(tours(events)).toEqual([]);
  });

  test("a drag of 40 px that starts on a node goes nowhere", async () => {
    await openView();
    const events = record();
    await startTour();
    const gamma = nodes().find((node) => node.textContent?.includes("Gamma"))!;
    const box = gamma.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    // A pan ends in a click on the node it started on: the pointer moved, so it is no tap.
    gamma.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 7 }),
    );
    gamma.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, clientX: x + 40, clientY: y, pointerId: 7 }),
    );
    document.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: x + 40, clientY: y, pointerId: 7 }),
    );
    gamma.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x + 40, clientY: y }));
    // Give a wrong jump the time it would take, then check nothing moved.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ringed()).toBe("Alpha");
    expect(tours(events)).toEqual([[1]]);
  });
});

describe("keyboard reach", () => {
  test("with the tour off Tab cycles through the visible buttons only", async () => {
    await openView();
    const visible = [
      ...view()!.querySelectorAll<HTMLButtonElement>(".docwalk-focus-toolbar button"),
    ]
      .filter((el) => !el.hidden && !el.disabled)
      .map((el) => el.getAttribute("aria-label"));
    expect(visible).toContain("Tour");
    expect(visible).not.toContain("Next node");
    const visited: (string | null)[] = [];
    for (let i = 0; i < visible.length + 1; i++) {
      await userEvent.keyboard("{Tab}");
      visited.push(document.activeElement?.getAttribute("aria-label") ?? null);
    }
    expect(new Set(visited)).toEqual(new Set(visible));
    expect(visited).not.toContain("Previous step");
    expect(visited).not.toContain("Next node");
  });

  test("with the tour on Tab reaches Back, Next and the Tour toggle, and an end that goes nowhere", async () => {
    await openView();
    await startTour();
    // At node 1 Back goes nowhere but stays a stop, so focus is never lost to it.
    expect(back()!.getAttribute("aria-disabled")).toBe("true");
    const visited = new Set<string | null>();
    for (let i = 0; i < 12; i++) {
      await userEvent.keyboard("{Tab}");
      visited.add(document.activeElement?.getAttribute("aria-label") ?? null);
    }
    expect(visited.has("Previous step")).toBe(true);
    expect(visited.has("Next node")).toBe(true);
    expect(visited.has("Tour")).toBe(true);
  });

  test("the toggle carries aria-pressed and a name that holds its visible word", async () => {
    await openView();
    const toggle = tourButton()!;
    expect(toggle.textContent).toBe("Tour");
    expect(toggle.getAttribute("aria-label")).toBe("Tour");
    expect(toggle.title).toBe("Step through the nodes (T)");
  });
});

describe("the status", () => {
  test("names the node, its place and the nodes it links to, as text", async () => {
    await openView();
    await startTour();
    await expect.poll(statusText).toContain("Tour started.");
    expect(statusText()).toContain("Alpha. Node 1 of 3.");
    expect(statusText()).toContain("Linked to: Beta.");
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(statusText).toContain("Beta. Node 2 of 3.");
    expect(statusText()).not.toContain("Tour started.");
    expect(statusText()).toContain("Alpha, Gamma");
    const status = view()!.querySelector(".docwalk-tour-status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    await userEvent.keyboard("{Escape}");
    expect(statusText()).toBe("Tour ended.");
  });
});

describe("diagrams with no tour", () => {
  test("a sequence diagram's view has no Tour button and T does nothing", async () => {
    const events = record();
    await openView(SEQUENCE);
    expect(tourButton()).toBeNull();
    expect(next()).toBeNull();
    await userEvent.keyboard("t");
    await userEvent.keyboard("{ArrowRight}");
    expect(view()!.querySelector(".docwalk-tour-layer")).toBeNull();
    expect(tours(events)).toEqual([]);
  });

  test("a diagram with one node has no tour either", async () => {
    await openView(SINGLE);
    expect(tourButton()).toBeNull();
    await userEvent.keyboard("t");
    expect(rings().length).toBe(0);
  });
});

async function mirrored() {
  const deck = mountDeck(FLOW);
  await deck.ready();
  const diagram = deck.container.querySelector<HTMLElement>(
    ".reveal .slides section.present .docwalk-diagram",
  )!;
  const closed: boolean[] = [];
  const handle = openMirroredFocus(diagram, "diagram", (byViewer) => closed.push(byViewer))!;
  expect(handle).not.toBeNull();
  return { handle, closed };
}

describe("a path from the mirror", () => {
  test("rings the same node, sends nothing back and drops numbers past the node count", async () => {
    const { handle } = await mirrored();
    const events = record();
    handle.setTour([1, 2]);
    await expect.poll(() => ringed()).toBe("Beta");
    expect(countText()).toBe("2 / 3");
    // The follower's own focus is left alone.
    expect(document.activeElement).not.toBe(next());
    handle.setTour([1, 99, 3]);
    await expect.poll(() => ringed()).toBe("Gamma");
    expect(tours(events)).toEqual([]);
    handle.setTour([]);
    await expect.poll(() => rings().length).toBe(0);
    expect(tourButton()!.getAttribute("aria-pressed")).toBe("false");
  });

  test("a path that arrives before the first Fit is drawn once Fit has run", async () => {
    const { handle } = await mirrored();
    // The view opened this frame and has not fitted yet.
    handle.setTour([2]);
    await expect.poll(() => ringed()).toBe("Beta");
  });

  test("Escape on a follower ends the tour without dismissing the view", async () => {
    const { handle, closed } = await mirrored();
    handle.setTour([1, 2]);
    await expect.poll(() => ringed()).toBe("Beta");
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => rings().length).toBe(0);
    expect(view()).not.toBeNull();
    expect(closed).toEqual([]);
    await userEvent.keyboard("{Escape}");
    expect(view()).toBeNull();
    expect(closed).toEqual([true]);
  });

  test("a path that ends while focus is on Next leaves focus on the Tour button", async () => {
    const { handle } = await mirrored();
    handle.setTour([1, 2]);
    await expect.poll(() => ringed()).toBe("Beta");
    next()!.focus();
    handle.setTour([]);
    await expect.poll(() => rings().length).toBe(0);
    expect(document.activeElement).toBe(tourButton());
  });
});
