import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import "./controls.css";
import type { SlideInfo } from "../deck/controller";
import type { AnchorIndex, HeadingTarget } from "./anchors";
import { attachSlideMarkers, SLIDE_MARKER_CLASS, SLIDE_MARKERS_CLASS } from "./slideMarkers";
import type { DocComment } from "./types";

/**
 * reveal.js scales the 1280x720 stage to the pane with a CSS transform
 * (decision 94). A button drawn in stage pixels scales with it: at 0.4 a
 * 24 px button is under 10 px on screen, too small to hit (WCAG 2.5.8). The
 * marker must stay at least 24 CSS px on screen at any scale, sit at the end
 * of its heading's text, and live outside the pages, which the exporters
 * and the overview copy.
 */

const headings: HeadingTarget[] = [
  { slug: "goals", title: "Goals", depth: 2, sectionId: "goals" },
  { slug: "risks", title: "Risks", depth: 3, sectionId: "goals" },
  { slug: "later", title: "Later", depth: 2, sectionId: "later" },
];
const index: AnchorIndex = {
  headings,
  bySlug: new Map(headings.map((h) => [h.slug, h])),
  diagrams: [],
};

const note = (id: string, slug: string, resolved = false): DocComment => ({
  id,
  anchor: { kind: "heading", slug },
  text: "Why?",
  created: 1,
  updated: 1,
  resolved,
});

const slide = (sectionId: string): SlideInfo => ({
  index: 0,
  address: `${sectionId}/1`,
  sectionId,
  page: 1,
  title: sectionId,
  flagged: false,
  note: null,
  text: "",
});

/** A page shaped like the deck's: section > .docwalk-slide > .docwalk-slide-body > headings. */
function section(id: string, parts: [tag: string, slug: string | null, text: string][]) {
  const el = document.createElement("section");
  el.dataset["docwalkId"] = id;
  el.dataset["page"] = "1";
  const frame = document.createElement("div");
  frame.className = "docwalk-slide";
  const body = document.createElement("div");
  body.className = "docwalk-slide-body";
  for (const [tag, slug, text] of parts) {
    const child = document.createElement(tag);
    if (slug) child.id = `user-content-${slug}`;
    child.textContent = text;
    body.append(child);
  }
  frame.append(body);
  el.append(frame);
  return el;
}

/** The stage at its design size, scaled from its top left corner the way reveal.js scales it. */
function stageAt(scale: number) {
  const stage = document.createElement("div");
  stage.className = "slides";
  stage.style.position = "absolute";
  stage.style.left = "0";
  stage.style.top = "0";
  stage.style.width = "1280px";
  stage.style.height = "720px";
  stage.style.transformOrigin = "0 0";
  stage.style.transform = `scale(${scale})`;
  const goals = section("goals", [
    ["h2", "goals", "Goals"],
    ["p", null, "Ship it."],
    ["h3", "risks", "Risks"],
  ]);
  const later = section("later", [["h2", "later", "Later"]]);
  later.hidden = true;
  stage.append(goals, later);
  document.body.append(stage);
  return { stage, goals, later };
}

/** The screen box of a heading's last line of text. */
function textEnd(heading: Element): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(heading);
  return [...range.getClientRects()].at(-1)!;
}

const markersOn = (stage: HTMLElement) => [
  ...stage.querySelectorAll<HTMLButtonElement>(`.${SLIDE_MARKER_CLASS}`),
];

let detach: (() => void) | null = null;

beforeEach(async () => {
  // Wide enough that the narrow-screen rule (44 px targets) stays off.
  await page.viewport(1400, 900);
});

afterEach(() => {
  detach?.();
  detach = null;
  document.body.replaceChildren();
});

describe("a marker on a scaled slide", () => {
  // Below scale 1 the marker keeps its size on screen; above it, it grows with the slide.
  test.each([
    [0.4, 24, 30],
    [2, 48, 60],
  ])(
    "at scale %s it is at least 24 CSS px on screen, at the end of its heading's text",
    (scale, least, most) => {
      const { stage, goals } = stageAt(scale);
      const markers = attachSlideMarkers(
        stage,
        () => slide("goals"),
        () => {},
      );
      detach = markers.destroy;
      markers.update(index, [note("a", "goals"), note("b", "goals"), note("c", "risks", true)]);

      // Two open comments on Goals; the one on Risks is resolved and marks nothing.
      const [button, ...rest] = markersOn(stage);
      expect(rest).toHaveLength(0);
      expect(button?.textContent).toBe("2");
      expect(button?.getAttribute("aria-label")).toBe("2 comments on “Goals”");

      const box = button!.getBoundingClientRect();
      expect(box.height).toBeGreaterThanOrEqual(least - 0.01);
      expect(box.height).toBeLessThan(most);
      expect(box.width).toBeGreaterThanOrEqual(least - 0.01);

      const line = textEnd(goals.querySelector("h2")!);
      const gap = box.left - line.right;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(8 * scale + 1);
      expect(Math.abs((box.top + box.bottom) / 2 - (line.top + line.bottom) / 2)).toBeLessThan(1);
    },
  );

  test("a click opens the panel on that heading", async () => {
    const { stage } = stageAt(0.4);
    const open = vi.fn<(slug: string) => void>();
    const markers = attachSlideMarkers(stage, () => slide("goals"), open);
    detach = markers.destroy;
    markers.update(index, [note("a", "risks")]);
    const [button] = markersOn(stage);
    expect(button?.getAttribute("aria-label")).toBe("1 comment on “Risks”");
    await userEvent.click(button!);
    expect(open).toHaveBeenCalledExactlyOnceWith("risks");
  });

  test("a new scale written on the stage lays the markers out again", async () => {
    const { stage } = stageAt(0.4);
    const markers = attachSlideMarkers(
      stage,
      () => slide("goals"),
      () => {},
    );
    detach = markers.destroy;
    markers.update(index, [note("a", "goals")]);
    expect(markersOn(stage)[0]!.getBoundingClientRect().height).toBeLessThan(30);
    // Past the second layout that update() schedules, so only the new style can trigger one.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // reveal.js writes its scale into the stage's style on a resize. Left as it was
    // drawn for 0.4 (2.5 times its size), the button would be 120 px tall at 2.
    stage.style.transform = "scale(2)";
    await expect
      .poll(() => Math.round(markersOn(stage)[0]?.getBoundingClientRect().height ?? 0))
      .toBe(48);
  });

  test("only the current slide's headings are marked", () => {
    const { stage, goals, later } = stageAt(1);
    let current = "goals";
    const markers = attachSlideMarkers(
      stage,
      () => slide(current),
      () => {},
    );
    detach = markers.destroy;
    markers.update(index, [note("a", "later")]);
    expect(markersOn(stage)).toHaveLength(0);
    goals.hidden = true;
    later.hidden = false;
    current = "later";
    markers.layout();
    expect(markersOn(stage).map((b) => b.getAttribute("aria-label"))).toEqual([
      "1 comment on “Later”",
    ]);
  });
});

describe("the marker layer", () => {
  test("sits on the stage beside the pages, never inside one, and destroy removes it", async () => {
    const { stage } = stageAt(0.4);
    const markers = attachSlideMarkers(
      stage,
      () => slide("goals"),
      () => {},
    );
    markers.update(index, [note("a", "goals")]);
    const layer = stage.querySelector(`:scope > .${SLIDE_MARKERS_CLASS}`);
    expect(layer?.querySelector(`.${SLIDE_MARKER_CLASS}`)).not.toBeNull();
    expect(stage.querySelector(`section .${SLIDE_MARKER_CLASS}`)).toBeNull();

    markers.destroy();
    expect(stage.querySelector(`.${SLIDE_MARKERS_CLASS}`)).toBeNull();
    // A scale change after destroy brings nothing back: the observer is gone.
    stage.style.transform = "scale(1)";
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stage.querySelector(`.${SLIDE_MARKERS_CLASS}, .${SLIDE_MARKER_CLASS}`)).toBeNull();
  });
});
