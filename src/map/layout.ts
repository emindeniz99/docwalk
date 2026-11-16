import type { HeadingDepth, SectionPlan } from "../sectioning/sectionize";

/**
 * A frame is one slide wide (`SLIDE_SIZE.width` in src/deck/pages.ts), so its
 * text has the size it has on a slide (decision 139). Kept apart from
 * pages.ts, which pulls in the sanitizer and DOM measuring code.
 */
export const FRAME_WIDTH = 1280;

/**
 * One slide's height: a short section's frame is never smaller than the
 * slide the deck makes of it, and an unmeasured frame still has a slide's
 * room on the map.
 */
export const MIN_FRAME_HEIGHT = 720;

/** Space between frames in a column, in slide units (5% of a frame's width). */
export const FRAME_GAP = 64;

/** Space between columns: three frame gaps, so a column's frames read as one group. */
export const COLUMN_GAP = 192;

/** One section of the plan on the map, addressed by the section's id (rule 7). */
export interface MapFrame {
  id: string;
  title: string;
  /** The depth of the section's heading; `null` for leading content and thematic-break parts. */
  depth: HeadingDepth | null;
}

export interface FrameRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0-based column, left to right. */
  column: number;
  /** 0-based place in the column, top to bottom. */
  row: number;
}

export interface MapPlacement {
  /** Every frame's rectangle, in document order. */
  frames: FrameRect[];
  /** The box from (0, 0) around every frame; 0 by 0 when there is none. */
  bounds: { width: number; height: number };
}

/**
 * The map's columns (decision 139): a section whose heading is at the plan's
 * first slide level opens a column, and every later section down to the next
 * such heading stacks under it. Sections before the first such heading form
 * the first column. Pass the plan at `auto`, never the viewer's override.
 */
export function mapColumns(plan: SectionPlan): MapFrame[][] {
  const columns: MapFrame[][] = [];
  for (const section of plan.sections) {
    const depth = section.heading?.depth ?? null;
    const frame: MapFrame = { id: section.id, title: section.title, depth };
    const last = columns.at(-1);
    if (last && depth !== plan.levels[0]) last.push(frame);
    else columns.push([frame]);
  }
  return columns;
}

/** A measured height in whole units, rounded up so nothing is cut (rule 3); broken ones get the minimum. */
function frameHeight(measured: number | undefined): number {
  if (measured === undefined || !Number.isFinite(measured)) return MIN_FRAME_HEIGHT;
  return Math.max(MIN_FRAME_HEIGHT, Math.ceil(measured));
}

/**
 * Rectangles for the columns from the measured content heights, keyed by
 * frame id: columns left to right with tops at 0, frames top to bottom. A
 * frame's place depends only on the frames before it in document order.
 */
export function placeFrames(
  columns: readonly (readonly Pick<MapFrame, "id">[])[],
  heights: ReadonlyMap<string, number>,
): MapPlacement {
  const frames: FrameRect[] = [];
  const bounds = { width: 0, height: 0 };
  columns.forEach((column, c) => {
    const x = c * (FRAME_WIDTH + COLUMN_GAP);
    let y = 0;
    column.forEach(({ id }, row) => {
      const height = frameHeight(heights.get(id));
      frames.push({ id, x, y, width: FRAME_WIDTH, height, column: c, row });
      bounds.width = Math.max(bounds.width, x + FRAME_WIDTH);
      bounds.height = Math.max(bounds.height, y + height);
      y += height + FRAME_GAP;
    });
  });
  return { frames, bounds };
}
