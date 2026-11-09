import { afterEach, describe, expect, test } from "vitest";
import "virtual:docwalk-tokens.css";
import { m } from "../paraglide/messages.js";
import { createDiagramTour } from "./diagramTour";
import { type DiagramEdge, diagramEdges, renderDiagrams } from "./mermaid";
import { TOUR_DIM_OPACITY, TOUR_MAX_NEIGHBOURS_READ } from "./tourModel";

/**
 * The tour draws on the focus view's copy of the SVG (decision 109). These
 * tests clone a rendered diagram into a sized stage the way the view does,
 * keep its ids, and check what is drawn from the computed styles a viewer
 * sees: the rings and lines take the design tokens whatever the author's
 * `classDef` says, the words and fills keep their colours, and `clear`
 * leaves the SVG as it was.
 */

const CHAIN = `flowchart LR
  a[Alpha] --> b[Beta]
  b --> c[Gamma]
  c --> d[Delta]
  classDef x fill:#000,color:#fff,stroke:#f00
  class a x
  style b stroke-width:4px,stroke:#0f0`;

let mounted: HTMLElement[] = [];
afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
});

interface Mounted {
  stage: HTMLElement;
  svg: SVGSVGElement;
  edges: readonly DiagramEdge[];
}

/** Render `source`, then put a copy of its SVG into a sized stage as the diagram focus view does. */
async function mount(source: string): Promise<Mounted> {
  const article = document.createElement("article");
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = "language-mermaid";
  code.textContent = `${source}\n`;
  pre.append(code);
  article.append(pre);
  document.body.append(article);
  const [result] = await renderDiagrams(article);
  expect(result?.ok).toBe(true);
  const host = article.querySelector<HTMLElement>("figure.docwalk-diagram")!;
  const copy = host.querySelector("svg")!.cloneNode(true) as SVGSVGElement;
  article.remove();
  // The view sizes the diagram itself.
  copy.removeAttribute("style");
  copy.removeAttribute("width");
  copy.removeAttribute("height");
  copy.setAttribute("width", "800");
  copy.setAttribute("height", "300");
  const stage = document.createElement("div");
  Object.assign(stage.style, { width: "900px", height: "400px", background: "#fff" });
  stage.append(copy);
  document.body.append(stage);
  mounted.push(stage);
  return { stage, svg: copy, edges: diagramEdges(host) };
}

/** The computed colour a token resolves to, as `rgb(...)`. */
function token(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(--dw-color-${name})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

const layerOf = (svg: SVGSVGElement) => svg.querySelector<SVGGElement>("g.docwalk-tour-layer");
const marks = (svg: SVGSVGElement, cls: string) => [
  ...svg.querySelectorAll<SVGElement>(`g.docwalk-tour-layer .${cls}`),
];
const nodeNamed = (svg: SVGSVGElement, label: string) =>
  [...svg.querySelectorAll<SVGGElement>("g.node")].find((g) => g.textContent?.trim() === label)!;

const box = (el: Element) => el.getBoundingClientRect();

function contains(outer: DOMRect, inner: DOMRect) {
  const eps = 0.5;
  return (
    outer.left <= inner.left + eps &&
    outer.top <= inner.top + eps &&
    outer.right >= inner.right - eps &&
    outer.bottom >= inner.bottom - eps
  );
}

function tourOf({ svg, edges }: Mounted, options?: { fitted?: Promise<unknown> }) {
  const said: string[] = [];
  const tour = createDiagramTour(svg, edges, (text: string) => said.push(text), options);
  return { tour, said };
}

describe("show: rings, a path line and the dimmed edges", () => {
  test("the current node has a solid primary ring, an earlier step a dashed primary-ink ring, the edge between them a line", async () => {
    const view = await mount(CHAIN);
    const { tour } = tourOf(view);
    expect(tour.count).toBe(4);
    await tour.show([1, 2]);

    const rings = marks(view.svg, "docwalk-tour-ring");
    const trail = marks(view.svg, "docwalk-tour-trail");
    const edges = marks(view.svg, "docwalk-tour-edge");
    expect([rings.length, trail.length, edges.length]).toEqual([1, 1, 1]);
    expect(getComputedStyle(rings[0]!).stroke).toBe(token("primary"));
    expect(getComputedStyle(rings[0]!).strokeDasharray).toBe("none");
    expect(getComputedStyle(trail[0]!).stroke).toBe(token("primary-ink"));
    expect(getComputedStyle(trail[0]!).strokeDasharray).not.toBe("none");
    expect(getComputedStyle(edges[0]!).stroke).toBe(token("primary-ink"));
    for (const el of [...rings, ...trail, ...edges]) {
      expect(getComputedStyle(el).fill).toBe("none");
      expect(getComputedStyle(el).pointerEvents).toBe("none");
    }

    // The ring is on Beta (node 2), the dashed ring on Alpha, and the line on a -> b.
    expect(contains(box(rings[0]!), box(nodeNamed(view.svg, "Beta")))).toBe(true);
    expect(contains(box(trail[0]!), box(nodeNamed(view.svg, "Alpha")))).toBe(true);
    expect(contains(box(rings[0]!), box(nodeNamed(view.svg, "Alpha")))).toBe(false);
    const abPath = view.svg.querySelector(`path[id$="-L_a_b_0"]`)!;
    expect(edges[0]!.getAttribute("d")).toBe(abPath.getAttribute("d"));
    expect(contains(box(edges[0]!), box(abPath)) || contains(box(abPath), box(edges[0]!))).toBe(
      true,
    );
  });

  test("the ring still contains the node after the stage is scaled with CSS, so zoom and Fit never move it", async () => {
    const view = await mount(CHAIN);
    const { tour } = tourOf(view);
    await tour.show([3]);
    const ring = marks(view.svg, "docwalk-tour-ring")[0]!;
    const node = nodeNamed(view.svg, "Gamma");
    expect(contains(ring.getBoundingClientRect(), node.getBoundingClientRect())).toBe(true);

    view.stage.style.transformOrigin = "0 0";
    view.stage.style.transform = "translate(20px, 10px) scale(2)";
    expect(contains(ring.getBoundingClientRect(), node.getBoundingClientRect())).toBe(true);
    await tour.show([3]);
    const again = marks(view.svg, "docwalk-tour-ring")[0]!;
    expect(contains(again.getBoundingClientRect(), node.getBoundingClientRect())).toBe(true);
    // The tour moved neither the stage nor the canvas.
    expect(view.stage.style.transform).toBe("translate(20px, 10px) scale(2)");
  });

  test("an author's classDef and style cannot recolour the ring", async () => {
    // Alpha is white on black with a red outline, Beta has its own stroke.
    const view = await mount(CHAIN);
    const { tour } = tourOf(view);
    for (const path of [[1], [2], [1, 2]]) {
      await tour.show(path);
      const ring = marks(view.svg, "docwalk-tour-ring")[0]!;
      expect(getComputedStyle(ring).stroke).toBe(token("primary"));
      expect(getComputedStyle(ring).strokeWidth).toBe("4px");
    }
  });

  test("words and fills keep their colours and nothing on the way up fades them", async () => {
    const view = await mount(CHAIN);
    const words = [...view.svg.querySelectorAll<SVGElement>("text, tspan")];
    expect(words.length).toBeGreaterThan(0);
    const fills = () => words.map((el) => getComputedStyle(el).fill);
    const before = fills();
    const nodeFills = () =>
      [...view.svg.querySelectorAll<SVGElement>("g.node rect, g.node path")].map(
        (el) => getComputedStyle(el).fill,
      );
    const nodeBefore = nodeFills();
    const { tour } = tourOf(view);
    await tour.show([1, 2, 3]);

    expect(fills()).toEqual(before);
    expect(nodeFills()).toEqual(nodeBefore);
    for (const word of words) {
      let product = 1;
      for (let el: Element | null = word; el; el = el.parentElement) {
        product *= Number(getComputedStyle(el).opacity);
        if (el === view.svg) break;
      }
      expect(product).toBe(1);
    }
  });

  test("only edge paths off the path and away from the current node fade, to TOUR_DIM_OPACITY", async () => {
    const view = await mount(CHAIN);
    const { tour } = tourOf(view);
    await tour.show([1, 2]);

    const dimmed = [...view.svg.querySelectorAll("[data-docwalk-tour-dim]")];
    const byId = (suffix: string) => view.svg.querySelector(`path[id$="-${suffix}"]`)!;
    // a -> b is on the path, b -> c touches Beta, c -> d is neither.
    expect(dimmed).toEqual([byId("L_c_d_0")]);
    expect(Number(getComputedStyle(dimmed[0]!).opacity)).toBe(TOUR_DIM_OPACITY);
    expect(getComputedStyle(byId("L_a_b_0")).opacity).toBe("1");
    expect(getComputedStyle(byId("L_b_c_0")).opacity).toBe("1");

    // Only Delta's own edge is left bright when the tour moves to the last node.
    await tour.show([4]);
    expect(new Set(view.svg.querySelectorAll("[data-docwalk-tour-dim]"))).toEqual(
      new Set([byId("L_a_b_0"), byId("L_b_c_0")]),
    );
    expect(view.svg.querySelector("[data-docwalk-tour-dim]:not(path)")).toBeNull();
  });

  test("a second show replaces the marks, so one layer stays the last child of the svg", async () => {
    const view = await mount(CHAIN);
    const { tour } = tourOf(view);
    await tour.show([1]);
    await tour.show([1, 2]);
    await tour.show([1, 2, 3]);
    expect(view.svg.querySelectorAll("g.docwalk-tour-layer")).toHaveLength(1);
    expect(view.svg.lastElementChild).toBe(layerOf(view.svg));
    expect(layerOf(view.svg)!.getAttribute("aria-hidden")).toBe("true");
    expect(marks(view.svg, "docwalk-tour-ring")).toHaveLength(1);
    expect(marks(view.svg, "docwalk-tour-trail")).toHaveLength(2);
    expect(marks(view.svg, "docwalk-tour-edge")).toHaveLength(2);
  });

  test("numbers outside the diagram are ignored, so a path from another window rings nothing here", async () => {
    const view = await mount(CHAIN);
    const { tour } = tourOf(view);
    await tour.show([2, 99, 0, 2.5]);
    expect(marks(view.svg, "docwalk-tour-ring")).toHaveLength(1);
    expect(marks(view.svg, "docwalk-tour-trail")).toHaveLength(0);
    await tour.show([99]);
    expect(layerOf(view.svg)).toBeNull();
  });

  test("a node that has no size gets no ring and the status still reads it", async () => {
    const view = await mount(CHAIN);
    const { tour, said } = tourOf(view);
    nodeNamed(view.svg, "Gamma").style.display = "none";
    await tour.show([3]);
    expect(marks(view.svg, "docwalk-tour-ring")).toHaveLength(0);
    expect(said.at(-1)).toContain("Gamma");
  });
});

describe("clear", () => {
  test("restores the svg byte for byte, so the tour leaves nothing in the document", async () => {
    const view = await mount(CHAIN);
    const before = view.svg.outerHTML;
    const { tour } = tourOf(view);
    await tour.show([1]);
    await tour.show([1, 2, 3]);
    expect(view.svg.outerHTML).not.toBe(before);
    tour.clear();
    expect(view.svg.outerHTML).toBe(before);
    expect(view.svg.querySelector("[data-docwalk-tour-dim]")).toBeNull();
  });

  test("a show that waits for the first Fit draws nothing once the tour is cleared", async () => {
    const view = await mount(CHAIN);
    let fit!: () => void;
    const fitted = new Promise<void>((resolve) => (fit = resolve));
    const { tour } = tourOf(view, { fitted });
    const drawn = tour.show([1, 2]);
    tour.clear();
    fit();
    await drawn;
    expect(layerOf(view.svg)).toBeNull();
  });
});

describe("measuring waits for the first Fit (rule 4)", () => {
  test("show before the Fit stores the path, announces at once, and draws after the Fit", async () => {
    const view = await mount(CHAIN);
    let fit!: () => void;
    const fitted = new Promise<void>((resolve) => (fit = resolve));
    const { tour, said } = tourOf(view, { fitted });
    const drawn = tour.show([1, 2]);
    expect(said).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(layerOf(view.svg)).toBeNull();
    fit();
    await drawn;
    expect(marks(view.svg, "docwalk-tour-ring")).toHaveLength(1);
  });

  test("the last path wins when several arrive before the Fit", async () => {
    const view = await mount(CHAIN);
    let fit!: () => void;
    const fitted = new Promise<void>((resolve) => (fit = resolve));
    const { tour } = tourOf(view, { fitted });
    const first = tour.show([1]);
    const second = tour.show([1, 2, 3]);
    fit();
    await Promise.all([first, second]);
    expect(marks(view.svg, "docwalk-tour-ring")).toHaveLength(1);
    expect(marks(view.svg, "docwalk-tour-trail")).toHaveLength(2);
  });
});

describe("the status text", () => {
  test("names the node, its place and the nodes it links to", async () => {
    const view = await mount(CHAIN);
    const { tour, said } = tourOf(view);
    await tour.show([2]);
    expect(said.at(-1)).toBe(
      `${m.tour_step({ label: "Beta", number: 2, count: 4 })} ${m.tour_links({ names: "Alpha, Gamma" })}`,
    );
  });

  test("reads at most TOUR_MAX_NEIGHBOURS_READ names and counts the rest", async () => {
    const targets = Array.from({ length: 9 }, (_v, i) => `n${i}[Leaf ${i}]`);
    const view = await mount(`flowchart LR\n  hub[Hub] --> ${targets.join("\n  hub --> ")}`);
    const { tour, said } = tourOf(view);
    const hub = [...view.svg.querySelectorAll("g.node")].findIndex(
      (g) => g.textContent?.trim() === "Hub",
    );
    await tour.show([hub + 1]);
    const text = said.at(-1)!;
    expect(text).toContain(m.tour_links_more({ count: 9 - TOUR_MAX_NEIGHBOURS_READ }));
    expect(text.match(/Leaf \d/g)).toHaveLength(TOUR_MAX_NEIGHBOURS_READ);
  });

  test("a label made of markup stays text: the announcement is a string and the page gains no element", async () => {
    const view = await mount(`flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B[Safe]`);
    const { tour, said } = tourOf(view);
    await tour.show([1]);
    expect(typeof said.at(-1)).toBe("string");
    // Mermaid keeps the tag as the label's text; the tour only passes it on.
    expect(said.at(-1)).toContain("<img");
    expect(document.querySelector("img")).toBeNull();
    // Everything the tour drew is a rect or a path.
    const odd = [...layerOf(view.svg)!.querySelectorAll("*")].filter(
      (el) => !["rect", "path"].includes(el.localName),
    );
    expect(odd).toEqual([]);
  });
});

describe("nodeAt", () => {
  test("a target inside a node's label gives the node's number, the ground gives null", async () => {
    const view = await mount(CHAIN);
    const { tour } = tourOf(view);
    const label = nodeNamed(view.svg, "Gamma").querySelector("text, tspan")!;
    expect(tour.nodeAt(label)).toBe(3);
    expect(tour.nodeAt(nodeNamed(view.svg, "Alpha"))).toBe(1);
    expect(tour.nodeAt(view.svg)).toBeNull();
    expect(tour.nodeAt(view.stage)).toBeNull();
    expect(tour.nodeAt(null)).toBeNull();
    expect(tour.nodeAt(window)).toBeNull();
  });

  test("a click on a ringed node still reaches the node, so the layer never blocks a click", async () => {
    const view = await mount(CHAIN);
    const { tour } = tourOf(view);
    await tour.show([2]);
    const rect = nodeNamed(view.svg, "Beta").getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    expect(tour.nodeAt(hit)).toBe(2);
  });

  test("a diagram without nodes has a count of 0 and nothing to show", async () => {
    const view = await mount(`sequenceDiagram\n  Alice->>Bob: Hi`);
    const { tour, said } = tourOf(view);
    expect(tour.count).toBe(0);
    await tour.show([1]);
    expect(layerOf(view.svg)).toBeNull();
    expect(said).toEqual([]);
  });
});
