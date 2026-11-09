import { afterEach, describe, expect, test, vi } from "vitest";
import "virtual:docwalk-tokens.css";
import "../styles.css";
import { createAnnotationLayer } from "./layer";
import { openMarksStore } from "./marksStore";
import type { MarkEvent } from "./mirrorTypes";
import { loadMarks, marksSaver, readSlides, type MarksStore, type StoredSlide } from "./savedMarks";
import type { AnnotationLayer } from "./types";

/**
 * Saved marks through the real layer and the real IndexedDB (decision 105).
 * "Reload" here is what a page reload does to marks: the layer and its drauu
 * surfaces are destroyed, the store is opened again on a new connection, and
 * a new layer draws what it reads back.
 */

const DOC = "sha256:browser-test";
/** The fingerprint of each slide's text, as markKeys would compute it. */
const PRINTS: Record<string, string> = { "a/1": "aa", "b/1": "bb" };
const DRAW = '.docwalk-annotate-draw[data-active="true"]';

const layers: AnnotationLayer[] = [];
afterEach(() => {
  for (const layer of layers.splice(0)) layer.destroy();
  document.body.replaceChildren();
});

/** Each test gets a database of its own: the test files share one origin's IndexedDB. */
const freshDb = () => `docwalk-marks-test-${crypto.randomUUID()}`;

/** One page's worth of saved marks: store, document, a 400x300 stage and a layer on it. */
async function session(db: string, slide = "a/1", print = PRINTS[slide]!) {
  const store = await openMarksStore(db);
  const marks = await loadMarks(store, DOC, vi.fn());
  const host = document.createElement("div");
  Object.assign(host.style, { width: "400px", height: "300px", margin: "0" });
  document.body.append(host);
  const layer = createAnnotationLayer(host, {
    saved: (key, address) => marks.forKey(key, address),
  });
  layers.push(layer);
  const events: MarkEvent[] = [];
  layer.observe((event) => events.push(event));
  layer.observe(
    marksSaver(
      () => marks,
      (address) => PRINTS[address],
    ),
  );
  layer.setKey(`${slide}#${print}`, slide);
  const reload = async () => {
    await marks.settled();
    layer.destroy();
    layers.splice(layers.indexOf(layer), 1);
    host.remove();
  };
  return { store, marks, host, layer, events, reload };
}

function pointer(type: string, el: Element, x: number, y: number) {
  const rect = el.getBoundingClientRect();
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

function stroke(host: HTMLElement, from: [number, number], to: [number, number]) {
  const svg = host.querySelector(DRAW)!;
  pointer("pointerdown", svg, ...from);
  for (let i = 1; i <= 8; i++) {
    pointer(
      "pointermove",
      svg,
      from[0] + ((to[0] - from[0]) * i) / 8,
      from[1] + ((to[1] - from[1]) * i) / 8,
    );
  }
  pointer("pointerup", svg, ...to);
}

const shown = (host: HTMLElement) => [...host.querySelector(DRAW)!.children];
const lastMarks = (events: MarkEvent[]) =>
  events.flatMap((e) => (e.kind === "marks" ? [e] : [])).at(-1);
/** An arrow's line ends: drauu's head is a marker, which no bounding box includes. */
const ends = (el: Element) =>
  ["x1", "y1", "x2", "y2"].map((name) => Number(el.querySelector("line")!.getAttribute(name)));
const rec = (doc: string, slide: string): StoredSlide => ({
  doc,
  slide,
  text: "aa",
  strokes: [{ tool: "pen", color: "primary", points: [1, 1] }],
});

describe("saved marks across a reload", () => {
  test("pen and arrow marks come back on their slide, where they were drawn", async () => {
    const db = freshDb();
    const first = await session(db);
    first.layer.setMode("pen");
    stroke(first.host, [40, 60], [360, 240]);
    first.layer.setMode("arrow");
    stroke(first.host, [40, 240], [360, 60]);
    const [penWas, arrowWas] = shown(first.host);
    const penBox = (penWas as SVGPathElement).getBBox();
    const arrowEnds = ends(arrowWas!);
    first.layer.setKey("b/1#bb", "b/1");
    first.layer.setMode("pen");
    stroke(first.host, [100, 150], [300, 150]);
    await first.reload();

    const second = await session(db);
    const [pen, arrow, ...rest] = shown(second.host);
    expect(rest).toEqual([]);
    // The saved points are thinned to 2 slide px and put on the 4096 grid: a mark lands within a pixel or two.
    const box = (pen as SVGPathElement).getBBox();
    for (const side of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(box[side] - penBox[side])).toBeLessThan(3);
    }
    ends(arrow!).forEach((n, i) => expect(Math.abs(n - arrowEnds[i]!)).toBeLessThan(1));
    second.layer.setKey("b/1#bb", "b/1");
    expect(shown(second.host)).toHaveLength(1);
  });

  test("a slide whose text changed shows none of the old marks, and they wait for the text to come back", async () => {
    const db = freshDb();
    const first = await session(db);
    first.layer.setMode("pen");
    stroke(first.host, [40, 60], [360, 240]);
    await first.reload();

    const edited = await session(db, "a/1", "cc");
    expect(shown(edited.host)).toHaveLength(0);
    await edited.reload();
    const back = await session(db);
    expect(shown(back.host)).toHaveLength(1);
  });

  test("a restored mark can be erased, the erase undone, and each result is what the next reload shows", async () => {
    const db = freshDb();
    const first = await session(db);
    first.layer.setMode("pen");
    stroke(first.host, [40, 150], [360, 150]);
    await first.reload();

    const second = await session(db);
    second.layer.setMode("eraser");
    stroke(second.host, [200, 40], [200, 260]);
    expect(shown(second.host)).toHaveLength(0);
    await second.marks.settled();
    expect(readSlides(DOC, await second.store.load(DOC))).toEqual([]);
    second.layer.undo();
    expect(shown(second.host)).toHaveLength(1);
    await second.reload();

    const third = await session(db);
    expect(shown(third.host)).toHaveLength(1);
  });

  test("a restored mark reaches the mirror like a live one, so followers see what the slide shows", async () => {
    const db = freshDb();
    const first = await session(db);
    first.layer.setMode("pen");
    stroke(first.host, [40, 60], [360, 240]);
    const sent = lastMarks(first.events)!.strokes[0]!;
    await first.reload();

    const second = await session(db);
    expect(lastMarks(second.events)).toMatchObject({ slide: "a/1", reset: true });
    expect(lastMarks(second.events)!.strokes).toHaveLength(1);
    expect(lastMarks(second.events)!.strokes[0]!.points).toEqual(sent.points);
  });

  test("a restored mark keeps its colour key, drawn in that key's token", async () => {
    const db = freshDb();
    const first = await session(db);
    const ink = getComputedStyle(first.host).getPropertyValue("--dw-color-ink").trim();
    first.layer.setColor(ink, "ink");
    first.layer.setMode("pen");
    stroke(first.host, [40, 60], [360, 240]);
    await first.reload();

    const second = await session(db);
    expect(shown(second.host)[0]!.getAttribute("fill")).toBe(ink);
    expect(lastMarks(second.events)!.strokes[0]!.color).toBe("ink");
  });

  test("clearing the document's marks empties every slide, now and after a reload", async () => {
    const db = freshDb();
    const first = await session(db);
    first.layer.setMode("pen");
    stroke(first.host, [40, 60], [360, 240]);
    first.layer.setKey("b/1#bb", "b/1");
    stroke(first.host, [40, 60], [360, 240]);
    await first.reload();

    const second = await session(db);
    expect(second.marks.size).toBe(2);
    // What App does on "Delete saved marks": the store, then every surface of the layer.
    await second.marks.clear();
    second.layer.retain([]);
    second.layer.clear();
    expect(shown(second.host)).toHaveLength(0);
    second.layer.setKey("b/1#bb", "b/1");
    expect(shown(second.host)).toHaveLength(0);
    await second.reload();

    const third = await session(db);
    expect(shown(third.host)).toHaveLength(0);
    expect(third.marks.size).toBe(0);
  });
});

describe("the IndexedDB store", () => {
  test("reads one document's slides, not those of a document whose key starts the same", async () => {
    const store: MarksStore = await openMarksStore(freshDb());
    await store.put(rec("sha256:a", "x/1"));
    await store.put(rec("sha256:a", "y/1"));
    await store.put(rec("sha256:ab", "x/1"));
    await store.put(rec("sha256:", "x/1"));
    expect(readSlides("sha256:a", await store.load("sha256:a")).map((s) => s.slide)).toEqual([
      "x/1",
      "y/1",
    ]);
    await store.clear("sha256:a");
    expect(await store.load("sha256:a")).toEqual([]);
    expect(readSlides("sha256:ab", await store.load("sha256:ab"))).toHaveLength(1);
  });

  test("a record another writer left with markup in it draws nothing and reaches no element", async () => {
    // A same-origin script, an older build or a damaged profile can put anything in the store.
    const db = freshDb();
    const store = await openMarksStore(db);
    const hostile = {
      doc: DOC,
      slide: "a/1",
      text: "aa",
      strokes: [{ tool: "pen", color: "primary", points: [100, 100, 900, 900] }],
      html: '<img src="x" onerror="globalThis.pwned = true">',
    };
    await store.put(hostile as unknown as StoredSlide);
    await store.put({
      doc: DOC,
      slide: "b/1",
      text: "bb",
      strokes: [{ tool: "pen", color: 'red"><img src=x>', points: [1, 1] }],
    } as unknown as StoredSlide);

    const page = await session(db);
    expect(shown(page.host)).toHaveLength(0);
    page.layer.setKey("b/1#bb", "b/1");
    expect(shown(page.host)).toHaveLength(0);
    expect(document.querySelector("img")).toBeNull();
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
  });
});
