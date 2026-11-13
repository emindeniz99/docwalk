// The diagram tour's state, with no DOM (decision 109). A tour is a path of
// node numbers: 1-based positions in the order `nodesInDiagram` lists them,
// the last one current. Numbers travel between windows and node ids do not, so
// both sides must number the same nodes the same way. Node and Mermaid types
// stay out of this file so Node tests and the mirror schema can import it.

/** Steps a path keeps. A step past this drops the oldest. */
export const MAX_TOUR_STEPS = 64;
/** Highest node number a path may hold, in the app and on the wire. */
export const MAX_TOUR_NODES = 1000;
/** A diagram with fewer nodes has no tour. */
export const TOUR_MIN_NODES = 2;
/** Opacity of an edge off the path. Mermaid's default line colour keeps 3:1 on the slide. */
export const TOUR_DIM_OPACITY = 0.55;
/** Linked node names the status reads out before "and N more". */
export const TOUR_MAX_NEIGHBOURS_READ = 6;

/** Node numbers from 1, the last one current. Empty means no tour. */
export type TourPath = readonly number[];

/** One edge of the diagram as node numbers; `null` when an end is not a node. */
interface TourEdge {
  readonly from: number | null;
  readonly to: number | null;
}

export interface TourHighlight {
  /** The node the tour is on, or `null` without a tour. */
  current: number | null;
  /** Earlier steps, without the current node. */
  trail: Set<number>;
  /** Indexes of the edges that join two consecutive steps, in either direction. */
  pathEdges: Set<number>;
  /** Indexes of the edges with the current node at one end. */
  touching: Set<number>;
  /** The nodes at the other end of those edges, in node order, once each. */
  neighbours: number[];
}

/** The highest node number a path may hold for a diagram of `count` nodes. */
const limitFor = (count: number): number => Math.min(count, MAX_TOUR_NODES);

const isNode = (n: unknown, count: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= limitFor(count);

/** Append a step and keep the last `MAX_TOUR_STEPS`. */
function append(path: TourPath, n: number): TourPath {
  const next = [...path, n];
  return next.length > MAX_TOUR_STEPS ? next.slice(next.length - MAX_TOUR_STEPS) : next;
}

/** The tour at its first node, or no tour when the diagram is too small. */
export function startTour(count: number): TourPath {
  return count >= TOUR_MIN_NODES ? [1] : [];
}

/** Home: start again at the first node. */
export function firstStep(count: number): TourPath {
  return startTour(count);
}

/**
 * Next: the node after the current one. At the last node, and before a tour
 * has started, it returns `path` itself so a caller can tell nothing changed.
 */
export function nextStep(path: TourPath, count: number): TourPath {
  const current = path.at(-1);
  if (current === undefined || !isNode(current + 1, count)) return path;
  return append(path, current + 1);
}

/** Back: drop the last step. A single step stays, so Back never ends the tour. */
export function previousStep(path: TourPath): TourPath {
  return path.length > 1 ? path.slice(0, -1) : path;
}

/**
 * A click on a node: append it. A number that is not a node of the diagram,
 * the current node, or a tour that has not started returns `path` itself.
 */
export function jumpTo(path: TourPath, n: number, count: number): TourPath {
  const current = path.at(-1);
  if (current === undefined || !isNode(n, count) || n === current) return path;
  return append(path, n);
}

/**
 * The receiver's filter for a path from another window: whole numbers in
 * range only, a number repeated in a row once, the last `MAX_TOUR_STEPS`. A
 * diagram below `TOUR_MIN_NODES` has no tour, whatever the path says.
 */
export function normalizeTour(path: TourPath, count: number): TourPath {
  if (count < TOUR_MIN_NODES) return [];
  const kept: number[] = [];
  for (const n of path) {
    if (isNode(n, count) && kept.at(-1) !== n) kept.push(n);
  }
  return kept.length > MAX_TOUR_STEPS ? kept.slice(kept.length - MAX_TOUR_STEPS) : kept;
}

/** What to draw for a path, from the edges as node numbers. */
export function tourHighlight(path: TourPath, edges: readonly TourEdge[]): TourHighlight {
  const current = path.at(-1) ?? null;
  const trail = new Set<number>();
  for (const n of path) if (n !== current) trail.add(n);

  const joined = new Set<string>();
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1] as number;
    const b = path[i] as number;
    joined.add(`${a}>${b}`);
    joined.add(`${b}>${a}`);
  }

  const pathEdges = new Set<number>();
  const touching = new Set<number>();
  const others = new Set<number>();
  edges.forEach((edge, index) => {
    const { from, to } = edge;
    if (from !== null && to !== null && joined.has(`${from}>${to}`)) pathEdges.add(index);
    if (current === null) return;
    if (from === current || to === current) {
      touching.add(index);
      const other = from === current ? to : from;
      if (other !== null && other !== current) others.add(other);
    }
  });
  return { current, trail, pathEdges, touching, neighbours: [...others].toSorted((a, b) => a - b) };
}
