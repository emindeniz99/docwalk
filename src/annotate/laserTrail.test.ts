import { getStroke } from "perfect-freehand";
import { describe, expect, it } from "vitest";
import { LASER_SIZE, LASER_TRAIL_MS, freshTrail, trailOpacity, trailPath } from "./laserTrail";
import { outlinePath } from "./outline";

const at = (x: number, y: number, t: number) => ({ x, y, t });

describe("shared laser trail", () => {
  // The slides and the map both draw this trail. A change to either value is a
  // change to both surfaces, and a decision (the map's laser is decision 149).
  it("keeps the values the slides and the map agreed on", () => {
    expect(LASER_TRAIL_MS).toBe(600);
    expect(LASER_SIZE).toBe(12);
  });

  // The trail is gone LASER_TRAIL_MS after the pointer stops, so a point that
  // old must already be dropped: the last frame is the one before it expires.
  it("drops a point exactly at the duration and keeps one just under it", () => {
    const now = 10_000;
    const points = [
      at(0, 0, now - LASER_TRAIL_MS - 1),
      at(1, 1, now - LASER_TRAIL_MS),
      at(2, 2, now - LASER_TRAIL_MS + 1),
      at(3, 3, now),
    ];
    expect(freshTrail(points, now)).toEqual([points[2], points[3]]);
  });

  it("does not change the list it is given", () => {
    const points = [at(0, 0, 0), at(1, 1, 1000)];
    freshTrail(points, 1000);
    expect(points).toHaveLength(2);
  });

  // The opacity is the fade: full when the newest point is born, nothing when
  // it expires, linear between. Reduced motion never reaches it (it draws a dot).
  it("fades linearly from 1 at the newest point's birth to 0 at the duration", () => {
    const newest = at(0, 0, 5000);
    expect(trailOpacity(newest, 5000)).toBe(1);
    expect(trailOpacity(newest, 5000 + LASER_TRAIL_MS / 2)).toBe(0.5);
    expect(trailOpacity(newest, 5000 + LASER_TRAIL_MS)).toBe(0);
  });

  // Pins the stroke options so the two callers cannot drift: the path must
  // equal what perfect-freehand draws with the slides' settings, then outlinePath.
  it("draws the outline perfect-freehand gives for the slides' stroke settings", () => {
    const points = [at(10, 10, 0), at(40, 20, 16), at(80, 35, 32), at(120, 40, 48)];
    const expected = outlinePath(
      getStroke(
        points.map((p) => [p.x, p.y]),
        { size: 12, thinning: 0.6, smoothing: 0.5, streamline: 0.4, start: { taper: true } },
      ),
    );
    expect(expected).not.toBe("");
    expect(trailPath(points)).toBe(expected);
  });

  it("draws nothing for an empty trail", () => {
    expect(trailPath([])).toBe("");
  });
});
