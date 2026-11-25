import { getStroke } from "perfect-freehand";
import { outlinePath } from "./outline";

/*
 * The laser trail the slides and the map share. Kept apart from layer.ts so the
 * map's chunk can import it without pulling in drauu and the layer's CSS.
 */

/** How long a laser point stays on screen; the trail is gone this long after the pointer stops. */
export const LASER_TRAIL_MS = 600;

/** The dot's diameter and the trail's width, in CSS pixels. */
export const LASER_SIZE = 12;

const STROKE_OPTIONS = {
  size: LASER_SIZE,
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.4,
  start: { taper: true },
};

/** A trail point: a position and the `performance.now()` it was made at. */
export interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

/** The points still young enough to draw at `now`. */
export function freshTrail(points: TrailPoint[], now: number): TrailPoint[] {
  return points.filter((p) => now - p.t < LASER_TRAIL_MS);
}

/** The closed outline path of the trail; "" for fewer than two outline points. */
export function trailPath(points: TrailPoint[]): string {
  return outlinePath(
    getStroke(
      points.map((p) => [p.x, p.y]),
      STROKE_OPTIONS,
    ),
  );
}

/** The trail's opacity: 1 at the newest point's birth, 0 once it is `LASER_TRAIL_MS` old. */
export function trailOpacity(newest: TrailPoint, now: number): number {
  return 1 - (now - newest.t) / LASER_TRAIL_MS;
}
