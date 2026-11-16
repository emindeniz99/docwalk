import { afterEach, describe, expect, test, vi } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { createMapLaser, MAP_LASER_SIZE, MAP_LASER_TRAIL_MS } from "./laser";
import "./map.css";

/**
 * Decision 149, Pointing: the map's laser is drawn over the pane in screen
 * pixels, never inside the scaled layer, so its dot has one size at every
 * zoom; it fades with the slides' trail and draws the dot alone under
 * reduced motion. These tests drive `createMapLaser` with pane coordinates,
 * as MapView hands them over, and read the boxes the browser lays out.
 */

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** A pane as the map's: positioned, with a border, so pane coordinates start inside it. */
function makePane(): HTMLElement {
  const pane = document.createElement("section");
  pane.className = "docwalk-map-pane";
  Object.assign(pane.style, {
    position: "relative",
    width: "600px",
    height: "400px",
    border: "3px solid black",
    margin: "20px",
  });
  document.body.append(pane);
  return pane;
}

function reduceMotion() {
  const real = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) =>
    query.includes("prefers-reduced-motion")
      ? ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        } as MediaQueryList)
      : real(query),
  );
}

const dot = (pane: HTMLElement) =>
  pane.querySelector<SVGCircleElement>(".docwalk-map-laser circle");
const trail = (pane: HTMLElement) => pane.querySelector<SVGPathElement>(".docwalk-map-laser path");

/** The dot's centre on screen, relative to the pane's padding box. */
function dotCentre(pane: HTMLElement) {
  const box = dot(pane)!.getBoundingClientRect();
  const p = pane.getBoundingClientRect();
  return {
    x: box.left + box.width / 2 - p.left - pane.clientLeft,
    y: box.top + box.height / 2 - p.top - pane.clientTop,
    size: box.width,
  };
}

describe("the overlay (decision 149)", () => {
  test("sits in the pane, hidden from assistive technology, and never takes the pointer", () => {
    // A pointer-events overlay would swallow the wheel and the keys' targets; an
    // exposed SVG would be read out as an image with no name.
    const pane = makePane();
    const laser = createMapLaser(pane);
    cleanups.push(() => laser.dispose());
    const overlay = pane.querySelector<SVGSVGElement>(".docwalk-map-laser")!;
    expect(overlay.parentElement).toBe(pane);
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(getComputedStyle(overlay).pointerEvents).toBe("none");
    const o = overlay.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    expect(o.left).toBeCloseTo(p.left + pane.clientLeft, 1);
    expect(o.top).toBeCloseTo(p.top + pane.clientTop, 1);
    expect(o.width).toBeCloseTo(pane.clientWidth, 1);
    expect(o.height).toBeCloseTo(pane.clientHeight, 1);
  });

  test("dispose removes the overlay, and a late point or hide does nothing", () => {
    // A pointer event already queued when the view unmounts must not draw or throw.
    const pane = makePane();
    const laser = createMapLaser(pane);
    laser.point(100, 100);
    laser.dispose();
    expect(pane.querySelector(".docwalk-map-laser")).toBeNull();
    expect(() => {
      laser.point(120, 120);
      laser.hide();
      laser.dispose();
    }).not.toThrow();
    expect(pane.querySelector(".docwalk-map-laser")).toBeNull();
  });
});

describe("the dot (decision 149, Pointing)", () => {
  test("is centred on the point it is given, in pane pixels, at the slides' size", () => {
    const pane = makePane();
    const laser = createMapLaser(pane);
    cleanups.push(() => laser.dispose());
    laser.point(150, 90);
    const at = dotCentre(pane);
    expect(Math.abs(at.x - 150)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(at.y - 90)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(at.size - MAP_LASER_SIZE)).toBeLessThanOrEqual(0.5);
    laser.point(400, 300);
    const moved = dotCentre(pane);
    expect(Math.abs(moved.x - 400)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(moved.y - 300)).toBeLessThanOrEqual(0.5);
  });

  test("hide removes the dot until the next point", () => {
    // The dot goes when the pointer leaves the pane or a finger lifts.
    const pane = makePane();
    const laser = createMapLaser(pane);
    cleanups.push(() => laser.dispose());
    laser.point(150, 90);
    expect(dot(pane)).not.toBeNull();
    laser.hide();
    expect(dot(pane)).toBeNull();
    laser.point(160, 95);
    expect(dot(pane)).not.toBeNull();
  });
});

describe("the trail (decision 149, the slides' look)", () => {
  test("a moving pointer leaves a trail that is gone the trail's time after it stops; the dot stays", async () => {
    const pane = makePane();
    const laser = createMapLaser(pane);
    cleanups.push(() => laser.dispose());
    for (let i = 0; i < 6; i++) {
      laser.point(100 + i * 20, 100 + i * 5);
      await frame();
    }
    await frame();
    const path = trail(pane);
    expect(path, "a trail behind the dot").not.toBeNull();
    expect(path!.getAttribute("d")).toMatch(/^M /);
    expect(Number(path!.getAttribute("opacity"))).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, MAP_LASER_TRAIL_MS + 100));
    await frame();
    await frame();
    expect(trail(pane), "the trail has faded").toBeNull();
    expect(dot(pane), "the pointer is still on the pane").not.toBeNull();
  });

  test("hide leaves the trail to fade on its own", async () => {
    const pane = makePane();
    const laser = createMapLaser(pane);
    cleanups.push(() => laser.dispose());
    for (let i = 0; i < 4; i++) {
      laser.point(100 + i * 20, 100);
      await frame();
    }
    laser.hide();
    await frame();
    expect(dot(pane)).toBeNull();
    expect(trail(pane)).not.toBeNull();
  });

  test("with reduced motion only the dot is drawn, never a trail", async () => {
    reduceMotion();
    const pane = makePane();
    const laser = createMapLaser(pane);
    cleanups.push(() => laser.dispose());
    for (let i = 0; i < 6; i++) {
      laser.point(100 + i * 20, 100 + i * 5);
      await frame();
    }
    await frame();
    expect(trail(pane)).toBeNull();
    expect(dot(pane)).not.toBeNull();
    const at = dotCentre(pane);
    expect(Math.abs(at.x - 200)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(at.y - 125)).toBeLessThanOrEqual(0.5);
  });
});
