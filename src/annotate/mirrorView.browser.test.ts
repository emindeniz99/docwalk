import { afterEach, describe, expect, test, vi } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { MirrorStore } from "./mirrorStore";
import { attachMirror, type MirrorView } from "./mirrorView";
import { MIRROR_LASER_IDLE_MS, type MirrorOp } from "./mirrorTypes";

/**
 * The presenter's marks and laser as a follower sees them (decision 88). The
 * overlay is the receiving page's own drawing of numbers, so these tests look
 * at where marks land at different sizes, which colour they take and that
 * nothing from a message becomes markup.
 */

let view: MirrorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  vi.useRealTimers();
  document.body.replaceChildren();
});

/** A stand-in for the slide box at `width` x `height`, with a button under the overlay. */
function slideBox(width: number, height: number) {
  const host = document.createElement("div");
  Object.assign(host.style, { width: `${width}px`, height: `${height}px`, margin: "0" });
  const button = document.createElement("button");
  button.textContent = "Under the marks";
  Object.assign(button.style, { position: "absolute", left: "10px", top: "10px" });
  host.append(button);
  document.body.append(host);
  return { host, button };
}

type StrokeOp = Extract<MirrorOp, { op: "stroke" }>;
const stroke = (over: Partial<StrokeOp> = {}): MirrorOp => ({
  op: "stroke",
  slide: "a/1",
  id: 1,
  tool: "pen",
  color: "primary",
  from: 0,
  points: [1024, 1024, 2048, 2048, 3072, 3072],
  end: true,
  ...over,
});

const marks = (host: HTMLElement) => host.querySelectorAll(".docwalk-mirror [data-mark]");

/** The overlay draws on a short timer so changes that arrive together are drawn together. */
const drawn = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("marks on the receiving slide", () => {
  test("shows the strokes of the slide on screen and no other slide's", () => {
    const { host } = slideBox(640, 360);
    const store = new MirrorStore();
    store.apply(stroke({ slide: "a/1", id: 1 }));
    store.apply(stroke({ slide: "b/1", id: 2 }));
    let address = "a/1";
    view = attachMirror(host, store, () => address);
    expect([...marks(host)].map((el) => el.getAttribute("data-mark"))).toEqual(["1"]);
    address = "b/1";
    view.refresh();
    expect([...marks(host)].map((el) => el.getAttribute("data-mark"))).toEqual(["2"]);
    address = "c/1";
    view.refresh();
    expect(marks(host)).toHaveLength(0);
  });

  test("a stroke that arrives later is drawn, and one that is dropped goes", async () => {
    const { host } = slideBox(640, 360);
    const store = new MirrorStore();
    view = attachMirror(host, store, () => "a/1");
    store.apply(stroke({ id: 1, end: false }));
    await drawn();
    expect(marks(host)).toHaveLength(1);
    const before = marks(host)[0]!.getAttribute("d");
    store.apply(stroke({ id: 1, from: 6, points: [3500, 3500], end: true }));
    await drawn();
    expect(marks(host)[0]!.getAttribute("d")).not.toBe(before);
    store.apply({ op: "drop", slide: "a/1", ids: [1] });
    await drawn();
    expect(marks(host)).toHaveLength(0);
  });

  test("a stroke replaced by one with the same id and length is drawn again (decision 103)", async () => {
    // Ids restart after a presenter reload, and a resync no longer clears
    // the slide first, so the replacement is the only change the view sees.
    const { host } = slideBox(640, 360);
    const store = new MirrorStore();
    view = attachMirror(host, store, () => "a/1");
    store.apply(stroke({ id: 1, points: [1024, 1024, 2048, 2048, 3072, 3072] }));
    await drawn();
    const before = marks(host)[0]!.getAttribute("d");
    store.apply(stroke({ id: 1, points: [3072, 1024, 2048, 2048, 1024, 3072] }));
    await drawn();
    expect(marks(host)).toHaveLength(1);
    expect(marks(host)[0]!.getAttribute("d")).not.toBe(before);
  });

  test("a pen stroke is a filled path and an arrow a line with a head", () => {
    const { host } = slideBox(640, 360);
    const store = new MirrorStore();
    store.apply(stroke({ id: 1 }));
    store.apply(stroke({ id: 2, tool: "arrow", points: [512, 512, 3584, 1024] }));
    view = attachMirror(host, store, () => "a/1");
    const [pen, arrow] = marks(host);
    expect(pen!.localName).toBe("path");
    expect(arrow!.localName).toBe("g");
    expect(arrow!.querySelector("line")).not.toBeNull();
    const head = arrow!.querySelector("path")?.getAttribute("d");
    expect(head).toMatch(/^M [\d. -]+ L [\d. -]+ L [\d. -]+ Z$/);
  });

  test("a rectangle is a <rect> over the box of its two corners, whichever corner comes first (decision 110)", () => {
    const { host } = slideBox(640, 360);
    const store = new MirrorStore();
    // Bottom-right corner first: 3072 and 2048 of 4096 are 960 and 360 slide px across and down.
    store.apply(stroke({ id: 1, tool: "rect", points: [3072, 2048, 1024, 1024] }));
    store.apply(stroke({ id: 2, tool: "rect", points: [1024, 1024, 3072, 2048] }));
    view = attachMirror(host, store, () => "a/1");
    const [first, second] = [...marks(host)] as SVGRectElement[];
    expect(first!.localName).toBe("rect");
    const box = (el: SVGElement) =>
      ["x", "y", "width", "height"].map((a) => Number(el.getAttribute(a)));
    expect(box(first!)).toEqual([320, 180, 640, 180]);
    expect(box(second!)).toEqual(box(first!));
  });

  test("an ellipse is an <ellipse> with its centre and radii from the box of its corners", () => {
    const { host } = slideBox(640, 360);
    const store = new MirrorStore();
    store.apply(stroke({ id: 1, tool: "ellipse", points: [3072, 2048, 1024, 1024] }));
    view = attachMirror(host, store, () => "a/1");
    const ellipse = marks(host)[0]!;
    expect(ellipse.localName).toBe("ellipse");
    expect(["cx", "cy", "rx", "ry"].map((a) => Number(ellipse.getAttribute(a)))).toEqual([
      640, 270, 320, 90,
    ]);
  });

  test("a shape is stroked in the key's design token and left unfilled", () => {
    const { host } = slideBox(640, 360);
    const store = new MirrorStore();
    store.apply(stroke({ id: 1, tool: "rect", color: "ink", points: [1024, 1024, 3072, 2048] }));
    store.apply(
      stroke({ id: 2, tool: "ellipse", color: "focus", points: [1024, 1024, 3072, 2048] }),
    );
    view = attachMirror(host, store, () => "a/1");
    const probe = document.createElement("span");
    document.body.append(probe);
    const token = (name: string) => {
      probe.style.color = `var(--dw-color-${name})`;
      return getComputedStyle(probe).color;
    };
    const [rect, ellipse] = marks(host);
    expect(getComputedStyle(rect!).stroke).toBe(token("ink"));
    expect(getComputedStyle(ellipse!).stroke).toBe(token("focus"));
    expect(getComputedStyle(rect!).fill).toBe("none");
    expect(getComputedStyle(ellipse!).fill).toBe("none");
    expect(getComputedStyle(rect!).strokeWidth).toBe("4px");
  });

  test("a mark lands on the same spot of the slide at any size", () => {
    const centres: { x: number; y: number }[] = [];
    for (const [width, height] of [
      [1280, 720],
      [400, 225],
    ] as const) {
      const { host } = slideBox(width, height);
      const store = new MirrorStore();
      store.apply(stroke({ points: [512, 1024, 1024, 1024, 1536, 1024] }));
      view = attachMirror(host, store, () => "a/1");
      const rect = marks(host)[0]!.getBoundingClientRect();
      const frame = host.getBoundingClientRect();
      centres.push({
        x: (rect.left + rect.width / 2 - frame.left) / frame.width,
        y: (rect.top + rect.height / 2 - frame.top) / frame.height,
      });
      view.destroy();
      view = null;
      host.remove();
    }
    // 1024 of 4096 is a quarter across and a quarter down.
    for (const centre of centres) {
      expect(centre.x).toBeCloseTo(0.25, 1);
      expect(centre.y).toBeCloseTo(0.25, 1);
    }
    expect(centres[0]!.x).toBeCloseTo(centres[1]!.x, 2);
    expect(centres[0]!.y).toBeCloseTo(centres[1]!.y, 2);
  });

  test("the colour is the receiving page's design token for the key, so a theme change recolours it", () => {
    const { host } = slideBox(640, 360);
    const store = new MirrorStore();
    store.apply(stroke({ id: 1, color: "ink" }));
    store.apply(stroke({ id: 2, color: "focus" }));
    view = attachMirror(host, store, () => "a/1");
    const probe = document.createElement("span");
    document.body.append(probe);
    const token = (name: string) => {
      probe.style.color = `var(--dw-color-${name})`;
      return getComputedStyle(probe).color;
    };
    const [ink, focus] = marks(host);
    expect(getComputedStyle(ink!).fill).toBe(token("ink"));
    expect(getComputedStyle(focus!).fill).toBe(token("focus"));
    expect(token("ink")).not.toBe(token("focus"));
  });

  test("a hostile address or key never becomes markup or script", () => {
    const { host } = slideBox(640, 360);
    const hostile = '<img src=x onerror="window.pwned = 1">';
    const store = new MirrorStore();
    store.apply(stroke({ slide: hostile }));
    view = attachMirror(host, store, () => hostile);
    expect(marks(host)).toHaveLength(1);
    expect(host.querySelector("img")).toBeNull();
    expect(host.innerHTML).not.toContain("onerror");
    expect((window as { pwned?: number }).pwned).toBeUndefined();
  });

  test("the overlay takes no pointer event and hides from assistive technology", () => {
    const { host, button } = slideBox(640, 360);
    const store = new MirrorStore();
    store.apply(stroke());
    view = attachMirror(host, store, () => "a/1");
    const root = host.querySelector(".docwalk-mirror")!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    const rect = button.getBoundingClientRect();
    expect(document.elementFromPoint(rect.left + 5, rect.top + 5)).toBe(button);
  });

  test("destroy removes the overlay and gives the host its position back", () => {
    const { host } = slideBox(640, 360);
    view = attachMirror(host, new MirrorStore(), () => "a/1");
    expect(host.style.position).toBe("relative");
    view.destroy();
    view = null;
    expect(host.querySelector(".docwalk-mirror")).toBeNull();
    expect(host.style.position).toBe("");
  });
});

describe("the laser on the receiving slide", () => {
  test("is a dot at the presenter's spot of the slide, and goes with laser-off", async () => {
    const { host } = slideBox(640, 360);
    const store = new MirrorStore();
    view = attachMirror(host, store, () => "a/1");
    const dot = host.querySelector<HTMLElement>(".docwalk-remote-laser")!;
    expect(dot.hidden).toBe(true);
    store.apply({ op: "laser", x: 0.25, y: 0.75 });
    await drawn();
    expect(dot.hidden).toBe(false);
    expect(dot.style.left).toBe("25%");
    expect(dot.style.top).toBe("75%");
    store.apply({ op: "laser-off" });
    await drawn();
    expect(dot.hidden).toBe(true);
  });

  test("goes by itself after 3 s without an update, as a phone's laser does", () => {
    vi.useFakeTimers();
    const { host } = slideBox(640, 360);
    const store = new MirrorStore();
    view = attachMirror(host, store, () => "a/1");
    store.apply({ op: "laser", x: 0.5, y: 0.5 });
    vi.advanceTimersByTime(20);
    expect(host.querySelector<HTMLElement>(".docwalk-remote-laser")!.hidden).toBe(false);
    vi.advanceTimersByTime(MIRROR_LASER_IDLE_MS + 40);
    expect(store.laser).toBeNull();
    expect(host.querySelector<HTMLElement>(".docwalk-remote-laser")!.hidden).toBe(true);
  });

  test("an update keeps it on: the 3 s run from the last point", () => {
    vi.useFakeTimers();
    const { host } = slideBox(640, 360);
    const store = new MirrorStore();
    view = attachMirror(host, store, () => "a/1");
    store.apply({ op: "laser", x: 0.5, y: 0.5 });
    vi.advanceTimersByTime(2000);
    store.apply({ op: "laser", x: 0.6, y: 0.5 });
    vi.advanceTimersByTime(2000);
    expect(store.laser).toEqual({ x: 0.6, y: 0.5 });
  });
});
