import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import {
  firstStep,
  jumpTo,
  MAX_TOUR_NODES,
  MAX_TOUR_STEPS,
  nextStep,
  normalizeTour,
  previousStep,
  startTour,
  tourHighlight,
  type TourPath,
} from "./tourModel";

/** Steps 1..n by Next, the way a presenter walks a diagram. */
function walk(n: number, count: number): TourPath {
  let path = startTour(count);
  for (let i = 1; i < n; i += 1) path = nextStep(path, count);
  return path;
}

describe("startTour and firstStep", () => {
  test("a diagram with two nodes starts at the first, so the smallest tour has somewhere to go", () => {
    expect(startTour(2)).toEqual([1]);
    expect(firstStep(2)).toEqual([1]);
  });

  test("a diagram with fewer than two nodes has no tour, so a lone node never shows a button that does nothing", () => {
    expect(startTour(1)).toEqual([]);
    expect(startTour(0)).toEqual([]);
    expect(firstStep(1)).toEqual([]);
  });
});

describe("nextStep", () => {
  test("adds the node after the current one, so Next walks the drawing order", () => {
    expect(nextStep([1], 5)).toEqual([1, 2]);
    expect(nextStep([1, 2], 5)).toEqual([1, 2, 3]);
  });

  test("goes from the current node, not from the largest one visited, so a jump changes where Next leads", () => {
    expect(nextStep([1, 4], 5)).toEqual([1, 4, 5]);
    expect(nextStep([1, 4, 2], 5)).toEqual([1, 4, 2, 3]);
  });

  test("returns the same path object at the last node, so a held key sends no extra change", () => {
    const path = walk(3, 3);
    expect(nextStep(path, 3)).toBe(path);
  });

  test("stops at MAX_TOUR_NODES even when the diagram has more nodes, so a number never leaves the wire's range", () => {
    const path = [MAX_TOUR_NODES];
    expect(nextStep(path, MAX_TOUR_NODES + 500)).toBe(path);
    expect(nextStep([MAX_TOUR_NODES - 1], MAX_TOUR_NODES + 500)).toEqual([
      MAX_TOUR_NODES - 1,
      MAX_TOUR_NODES,
    ]);
  });

  test("does nothing before the tour has started", () => {
    const empty: TourPath = [];
    expect(nextStep(empty, 5)).toBe(empty);
  });

  test("the 65th step drops the oldest, so a long tour keeps its recent route", () => {
    const path = walk(MAX_TOUR_STEPS + 1, 200);
    expect(path).toHaveLength(MAX_TOUR_STEPS);
    expect(path[0]).toBe(2);
    expect(path.at(-1)).toBe(MAX_TOUR_STEPS + 1);
  });
});

describe("previousStep", () => {
  test("drops the last step, so Back returns to the node before", () => {
    expect(previousStep([1, 2, 3])).toEqual([1, 2]);
  });

  test("keeps one step, so Back never ends the tour", () => {
    const path: TourPath = [4];
    expect(previousStep(path)).toBe(path);
  });
});

describe("jumpTo", () => {
  test("appends the clicked node, so a presenter can pick a route", () => {
    expect(jumpTo([1, 2], 5, 7)).toEqual([1, 2, 5]);
  });

  test.each([
    ["the current node", 2],
    ["zero", 0],
    ["one past the count", 8],
    ["one past MAX_TOUR_NODES", MAX_TOUR_NODES + 1],
    ["a fraction", 2.5],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["a negative number", -1],
  ])("changes nothing for %s, so a stray click cannot corrupt the path", (_name, n) => {
    const path: TourPath = [1, 2];
    expect(jumpTo(path, n, 7)).toBe(path);
  });

  test("lets a later visit to an earlier node through, so a route can loop", () => {
    expect(jumpTo([1, 2], 1, 7)).toEqual([1, 2, 1]);
  });

  test("keeps the last MAX_TOUR_STEPS entries", () => {
    const path = jumpTo(walk(MAX_TOUR_STEPS, 200), 100, 200);
    expect(path).toHaveLength(MAX_TOUR_STEPS);
    expect(path.at(-1)).toBe(100);
    expect(path[0]).toBe(2);
  });

  test("does nothing before the tour has started, so a click does not start one by accident", () => {
    const empty: TourPath = [];
    expect(jumpTo(empty, 2, 7)).toBe(empty);
  });
});

describe("normalizeTour: the receiver's filter for a path from the wire", () => {
  test("keeps a good path as it is", () => {
    expect(normalizeTour([1, 2, 3, 2], 5)).toEqual([1, 2, 3, 2]);
  });

  test("drops numbers above the receiver's own node count, so a longer diagram on the other side rings nothing here", () => {
    expect(normalizeTour([1, 2, 9, 3], 4)).toEqual([1, 2, 3]);
  });

  test("drops negative, zero, fractional, huge and non-finite numbers", () => {
    const hostile = [
      -3,
      0,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      MAX_TOUR_NODES + 1,
      2,
    ];
    expect(normalizeTour(hostile, 5000)).toEqual([2]);
  });

  test("drops what is not a number, so a bad frame cannot reach the page", () => {
    const hostile = ["2", null, undefined, {}, [], true, 3] as unknown as TourPath;
    expect(normalizeTour(hostile, 5)).toEqual([3]);
  });

  test("collapses a number repeated in a row, so two equal steps never show as one", () => {
    expect(normalizeTour([1, 1, 1, 2, 2, 1], 5)).toEqual([1, 2, 1]);
  });

  test("collapses a repeat that only appears after a bad number is dropped", () => {
    expect(normalizeTour([2, 99, 2], 5)).toEqual([2]);
  });

  test("keeps the last MAX_TOUR_STEPS of 300 entries", () => {
    const long = Array.from({ length: 300 }, (_v, i) => (i % 2 === 0 ? 1 : 2));
    const out = normalizeTour(long, 5);
    expect(out).toHaveLength(MAX_TOUR_STEPS);
    expect(out.at(-1)).toBe(2);
  });

  test("an empty path stays empty, and a diagram below the minimum has no tour", () => {
    expect(normalizeTour([], 5)).toEqual([]);
    expect(normalizeTour([1], 1)).toEqual([]);
  });
});

describe("tourHighlight", () => {
  const edges = [
    { from: 1, to: 2 }, // 0: a -> b
    { from: 1, to: 2 }, // 1: a -> b drawn twice
    { from: 3, to: 2 }, // 2: c -> b
    { from: 3, to: 4 }, // 3: c -> d
    { from: 2, to: null }, // 4: b -> subgraph
    { from: null, to: 1 }, // 5: [*] -> a
    { from: 4, to: 4 }, // 6: d -> d
  ];

  test("a to b drawn twice puts both edges on the path", () => {
    const h = tourHighlight([1, 2], edges);
    expect([...h.pathEdges].toSorted()).toEqual([0, 1]);
  });

  test("b to a counts for the path a, b, so the direction a diagram draws does not matter", () => {
    const h = tourHighlight([2, 1], edges);
    expect([...h.pathEdges].toSorted()).toEqual([0, 1]);
  });

  test("only consecutive steps join, so a skipped node's edge stays off the path", () => {
    const h = tourHighlight([1, 2, 3], edges);
    expect([...h.pathEdges].toSorted()).toEqual([0, 1, 2]);
    expect(tourHighlight([1, 3], edges).pathEdges.size).toBe(0);
  });

  test("an edge with a null end is never on the path", () => {
    const h = tourHighlight([1, 2], edges);
    expect(h.pathEdges.has(4)).toBe(false);
    expect(h.pathEdges.has(5)).toBe(false);
    for (const path of [[1], [2], [1, 2], [2, 1], [4, 4]]) {
      const pe = tourHighlight(path, edges).pathEdges;
      expect(pe.has(4) || pe.has(5)).toBe(false);
    }
  });

  test("current is the last step and the trail holds the earlier ones without it", () => {
    const h = tourHighlight([1, 2, 3, 1], edges);
    expect(h.current).toBe(1);
    expect([...h.trail].toSorted()).toEqual([2, 3]);
  });

  test("touching holds every edge with the current node at one end, even one that ends in a subgraph", () => {
    const h = tourHighlight([3, 2], edges);
    expect([...h.touching].toSorted()).toEqual([0, 1, 2, 4]);
  });

  test("neighbours are the other ends in node order, once each, without the current node or a null end", () => {
    const h = tourHighlight([2], edges);
    expect(h.neighbours).toEqual([1, 3]);
    expect(tourHighlight([4], edges).neighbours).toEqual([3]);
    expect(tourHighlight([1], edges).neighbours).toEqual([2]);
  });

  test("an empty path highlights nothing", () => {
    const h = tourHighlight([], edges);
    expect(h.current).toBeNull();
    expect(h.trail.size + h.pathEdges.size + h.touching.size).toBe(0);
    expect(h.neighbours).toEqual([]);
  });
});

describe("the path stays valid whatever the viewer presses", () => {
  type Action =
    | { kind: "next" }
    | { kind: "back" }
    | { kind: "first" }
    | { kind: "jump"; n: number };

  const action: fc.Arbitrary<Action> = fc.oneof(
    fc.constant({ kind: "next" as const }),
    fc.constant({ kind: "back" as const }),
    fc.constant({ kind: "first" as const }),
    fc.record({
      kind: fc.constant("jump" as const),
      n: fc.oneof(fc.integer({ min: -5, max: 1100 }), fc.double({ noNaN: false })),
    }),
  );

  function apply(path: TourPath, a: Action, count: number): TourPath {
    switch (a.kind) {
      case "next":
        return nextStep(path, count);
      case "back":
        return previousStep(path);
      case "first":
        return firstStep(count);
      case "jump":
        return jumpTo(path, a.n, count);
    }
  }

  fcTest.prop([fc.integer({ min: 2, max: 1300 }), fc.array(action, { maxLength: 300 })])(
    "at most MAX_TOUR_STEPS entries, each in 1..count, never empty once started",
    (count, actions) => {
      let path = startTour(count);
      for (const a of actions) {
        path = apply(path, a, count);
        expect(path.length).toBeGreaterThanOrEqual(1);
        expect(path.length).toBeLessThanOrEqual(MAX_TOUR_STEPS);
        for (const n of path) {
          expect(Number.isInteger(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(1);
          expect(n).toBeLessThanOrEqual(Math.min(count, MAX_TOUR_NODES));
        }
      }
    },
  );

  fcTest.prop([fc.integer({ min: 2, max: 1300 }), fc.array(action, { maxLength: 100 })])(
    "Back after Next returns the same path while the tour is under the cap",
    (count, actions) => {
      let path = startTour(count);
      for (const a of actions) path = apply(path, a, count);
      fc.pre(path.length < MAX_TOUR_STEPS);
      const next = nextStep(path, count);
      fc.pre(next !== path); // at the last node Next changes nothing, so there is nothing to undo
      expect(previousStep(next)).toEqual(path);
    },
  );

  fcTest.prop([fc.integer({ min: 2, max: 1300 }), fc.array(action, { maxLength: 100 })])(
    "normalizeTour leaves a path the model made as it is",
    (count, actions) => {
      let path = startTour(count);
      for (const a of actions) path = apply(path, a, count);
      // A jump can repeat a node later in the route but never back to back.
      expect(normalizeTour(path, count)).toEqual(path);
    },
  );
});
