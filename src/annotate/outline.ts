/**
 * perfect-freehand outline points to an SVG path, closed with quadratic
 * curves. The annotation layer draws the laser trail with it, and the
 * mirror draws the presenter's pen strokes with it (decision 88).
 */
export function outlinePath(points: number[][]): string {
  if (points.length < 2) return "";
  const [first] = points as [number[]];
  let d = `M ${first[0]} ${first[1]} Q`;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i] as [number, number];
    const [x1, y1] = points[(i + 1) % points.length] as [number, number];
    d += ` ${x0} ${y0} ${(x0 + x1) / 2} ${(y0 + y1) / 2}`;
  }
  return `${d} Z`;
}
