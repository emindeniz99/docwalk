import { afterEach, describe, expect, test, vi } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { createAnnotationLayer, LASER_TRAIL_MS } from "./layer";
import type { AnnotationLayer } from "./types";

let layer: AnnotationLayer | null = null;

afterEach(() => {
  layer?.destroy();
  layer = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** A 400x300 slide stand-in with a button where a diagram node would be. */
function mount(): { host: HTMLElement; target: HTMLButtonElement } {
  const host = document.createElement("div");
  Object.assign(host.style, { width: "400px", height: "300px", margin: "0" });
  const target = document.createElement("button");
  target.textContent = "Diagram node";
  Object.assign(target.style, { position: "absolute", left: "150px", top: "120px" });
  host.append(target);
  document.body.append(host);
  layer = createAnnotationLayer(host);
  return { host, target };
}

/** The drawing surface of the current slide; every visited slide keeps one. */
const DRAW = '.docwalk-annotate-draw[data-active="true"]';

function pointer(type: string, el: EventTarget, x: number, y: number) {
  const rect = (el instanceof Element ? el : document.body).getBoundingClientRect();
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      pressure: 0.5,
      clientX: rect.left + x,
      clientY: rect.top + y,
    }),
  );
}

/** A stroke from synthetic pointer events, the same path drauu takes for mouse, touch and stylus. */
function stroke(host: HTMLElement, from: [number, number], to: [number, number]) {
  const svg = host.querySelector(DRAW) as SVGSVGElement;
  pointer("pointerdown", svg, ...from);
  for (let i = 1; i <= 8; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / 8;
    const y = from[1] + ((to[1] - from[1]) * i) / 8;
    pointer("pointermove", svg, x, y);
  }
  pointer("pointerup", svg, ...to);
}

const marks = (host: HTMLElement) => (host.querySelector(DRAW) as SVGSVGElement).children.length;

function centre(el: Element): [number, number] {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

describe("annotation layer (decision 29)", () => {
  test("mode off lets clicks reach the slide, so diagrams stay explorable between drawings", () => {
    const { target } = mount();
    const clicked = vi.fn<() => void>();
    target.addEventListener("click", clicked);

    expect(document.elementFromPoint(...centre(target))).toBe(target);
    target.click();
    expect(clicked).toHaveBeenCalledOnce();

    // The same point is covered while a tool is active, so the check above can fail.
    layer!.setMode("pen");
    expect(document.elementFromPoint(...centre(target))).not.toBe(target);
    layer!.setMode("off");
    expect(document.elementFromPoint(...centre(target))).toBe(target);
  });

  test("a pen stroke from pointer events leaves an SVG mark over the slide", () => {
    const { host } = mount();
    layer!.setColor("currentColor");
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    const path = host.querySelector(`${DRAW} path`);
    expect(path).not.toBeNull();
    expect(path!.getAttribute("d")?.length ?? 0).toBeGreaterThan(10);
  });

  test("before any setColor the pen draws in the accent, not the host's text colour", () => {
    // On the dark stage the host's text colour is light, so currentColor ink would vanish on a white slide.
    const { host } = mount();
    host.style.color = "white";
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    const fill = host.querySelector(`${DRAW} path`)!.getAttribute("fill");
    expect(fill).toBe(getComputedStyle(host).getPropertyValue("--dw-color-primary").trim());
    expect(fill).not.toBe("");
  });

  test("the arrow tool draws a line with an arrowhead, so a presenter can point at a node", () => {
    const { host } = mount();
    layer!.setMode("arrow");
    stroke(host, [20, 20], [200, 120]);
    const line = host.querySelector(`${DRAW} line`);
    expect(line?.getAttribute("marker-end")).toMatch(/^url\(/);
  });

  test("each slide keeps its own marks: switching slides hides them and coming back restores them", () => {
    const { host } = mount();
    layer!.setKey("intro/1");
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    expect(marks(host)).toBe(1);

    layer!.setKey("design/1");
    expect(marks(host)).toBe(0);
    stroke(host, [30, 200], [300, 200]);
    stroke(host, [30, 250], [300, 250]);
    expect(marks(host)).toBe(2);

    layer!.setKey("intro/1");
    expect(marks(host)).toBe(1);
    layer!.setKey("design/1");
    expect(marks(host)).toBe(2);
  });

  test("undo history survives a slide switch, so a presenter can undo a mark after coming back to its slide", () => {
    // Presenters often step ahead and back while talking. Saving and reloading
    // the drawing on each switch used to drop the undo stack: the marks came
    // back, but undo did nothing.
    const { host } = mount();
    layer!.setKey("intro/1");
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    stroke(host, [20, 200], [200, 220]);

    layer!.setKey("design/1");
    stroke(host, [30, 250], [300, 250]);
    layer!.setKey("intro/1");
    expect(marks(host)).toBe(2);

    layer!.undo();
    expect(marks(host)).toBe(1);
    layer!.redo();
    expect(marks(host)).toBe(2);
    // Undo on one slide never reaches into another slide's marks.
    layer!.undo();
    layer!.undo();
    layer!.undo();
    expect(marks(host)).toBe(0);
    layer!.setKey("design/1");
    expect(marks(host)).toBe(1);
  });

  test("only the current slide's marks are visible, and only its surface takes the pen", () => {
    const { host } = mount();
    layer!.setKey("intro/1");
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    layer!.setKey("design/1");
    const surfaces = [...host.querySelectorAll<SVGSVGElement>(".docwalk-annotate-draw")];
    expect(surfaces).toHaveLength(2);
    expect(surfaces.map((s) => getComputedStyle(s).display)).toEqual(["none", "block"]);
    // A colour or tool chosen on one slide is the one used on the next.
    layer!.setColor("rgb(1, 2, 3)");
    layer!.setKey("intro/1");
    stroke(host, [20, 200], [200, 220]);
    expect(host.querySelector(`${DRAW} path:last-child`)?.getAttribute("fill")).toBe(
      "rgb(1, 2, 3)",
    );
  });

  test("undo removes the last mark, redo brings it back, clear empties the slide", () => {
    const { host } = mount();
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    stroke(host, [20, 200], [200, 220]);
    expect(marks(host)).toBe(2);

    layer!.undo();
    expect(marks(host)).toBe(1);
    layer!.redo();
    expect(marks(host)).toBe(2);
    layer!.clear();
    expect(marks(host)).toBe(0);
  });

  test("the eraser removes a mark it crosses", () => {
    const { host } = mount();
    layer!.setMode("pen");
    stroke(host, [50, 150], [350, 150]);
    expect(marks(host)).toBe(1);
    layer!.setMode("eraser");
    stroke(host, [200, 50], [200, 250]);
    expect(marks(host)).toBe(0);
  });

  test("the laser trail removes itself shortly after the pointer stops, leaving the slide clean", async () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    const { host } = mount();
    layer!.setMode("laser");
    const laser = host.querySelector(".docwalk-annotate-laser") as SVGSVGElement;
    for (let i = 0; i < 10; i++) pointer("pointermove", laser, 40 + i * 20, 100);

    await expect.poll(() => laser.querySelector("path")).not.toBeNull();
    // Laser marks are never committed to the drawing.
    expect(marks(host)).toBe(0);
    await expect.poll(() => laser.childElementCount, { timeout: LASER_TRAIL_MS + 1000 }).toBe(0);
  });

  test("under reduced motion the laser has no trail and vanishes at once when the pointer lifts", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const { host } = mount();
    layer!.setMode("laser");
    const laser = host.querySelector(".docwalk-annotate-laser") as SVGSVGElement;
    pointer("pointerdown", laser, 100, 100);
    pointer("pointermove", laser, 120, 100);
    expect(laser.querySelector("circle")).not.toBeNull();
    expect(laser.querySelector("path")).toBeNull();
    pointer("pointerup", laser, 120, 100);
    expect(laser.childElementCount).toBe(0);
  });

  test("moveTo carries every slide's marks and undo history to a rebuilt stage", () => {
    // An agent write, a file reloaded from disk or a language switch rebuilds
    // the deck mid-talk, and the new deck has a new stage element. The
    // presenter's marks used to vanish with the old one.
    const { host } = mount();
    layer!.setKey("intro/1");
    layer!.setMode("pen");
    stroke(host, [20, 20], [200, 120]);
    layer!.setKey("design/1");
    stroke(host, [30, 200], [300, 200]);

    const rebuilt = document.createElement("div");
    Object.assign(rebuilt.style, { width: "400px", height: "300px" });
    document.body.append(rebuilt);
    layer!.moveTo(rebuilt);
    expect(host.querySelector(".docwalk-annotate")).toBeNull();
    expect(host.style.position).toBe("");
    expect(rebuilt.style.position).toBe("relative");
    expect(marks(rebuilt)).toBe(1);
    layer!.setKey("intro/1");
    expect(marks(rebuilt)).toBe(1);
    // The pen still draws on the new stage, and undo still reaches the old mark.
    stroke(rebuilt, [20, 200], [200, 220]);
    expect(marks(rebuilt)).toBe(2);
    layer!.undo();
    layer!.undo();
    expect(marks(rebuilt)).toBe(0);
  });

  test("retain drops the marks of slides that are gone, keeping the others and the current one", () => {
    // A mark drawn over text that has since changed points at the wrong thing,
    // so a rebuild keeps marks only for slides it still has.
    const { host } = mount();
    layer!.setMode("pen");
    for (const key of ["intro/1", "design/1", "risks/1"]) {
      layer!.setKey(key);
      stroke(host, [20, 20], [200, 120]);
    }
    layer!.retain(["intro/1"]);
    expect(marks(host)).toBe(1); // "risks/1" is current, so it stays until the slide changes
    layer!.setKey("design/1");
    expect(marks(host)).toBe(0);
    layer!.setKey("intro/1");
    expect(marks(host)).toBe(1);
    expect(host.querySelectorAll(".docwalk-annotate-draw").length).toBe(3);
  });

  test("destroy removes the overlay and restores the host, so remounting the deck leaves nothing behind", () => {
    const { host } = mount();
    expect(host.style.position).toBe("relative");
    layer!.destroy();
    layer = null;
    expect(host.querySelector(".docwalk-annotate")).toBeNull();
    expect(host.style.position).toBe("");
  });
});
