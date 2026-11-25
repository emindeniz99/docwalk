import type { Root } from "mdast";
import {
  autoSlideLevel,
  type HeadingDepth,
  sectionize,
  type SectionPlan,
} from "../sectioning/sectionize";

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

/** Space between frames of one group, in slide units (5% of a frame's width). */
export const FRAME_GAP = 64;

/**
 * Space between two groups in the one column: three frame gaps, so a section's
 * frames read as one group (decision 174).
 */
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
  /** 0-based group: a section with its parts, in document order (`mapColumns`). */
  column: number;
  /** 0-based place in the group, top to bottom. */
  row: number;
}

export interface MapPlacement {
  /** Every frame's rectangle, in document order. */
  frames: FrameRect[];
  /** The box from (0, 0) around every frame; 0 by 0 when there is none. */
  bounds: { width: number; height: number };
}

/**
 * The map's plan (decisions 140 and 141): sections at the document's own
 * level L, and at L + 1 when a top-level heading sits there, whatever follows
 * it. Every heading above L is a section, text or none, and the deck's cover
 * stays. A document with no L gets the plan of `auto`. Every caller sections
 * the map through here.
 */
export function mapPlan(root: Root): SectionPlan {
  const level = autoSlideLevel(root);
  if (level === null) return sectionize(root, "auto");
  const levels: HeadingDepth[] = [level];
  const deeper = root.children.some((n) => n.type === "heading" && n.depth === level + 1);
  if (deeper) levels.push((level + 1) as HeadingDepth);
  return sectionize(root, levels, { cover: true, emptyTitles: true });
}

/**
 * The map's groups (decisions 139 and 140): a section whose heading is at the
 * plan's first level or above opens a group, and every later section down to
 * the next such heading belongs to it. Sections before the first such heading
 * form the first group. `placeFrames` lays the groups out one after the other
 * in a single column (decision 174). Pass `mapPlan`'s plan.
 */
export function mapColumns(plan: SectionPlan): MapFrame[][] {
  const columns: MapFrame[][] = [];
  const level = plan.levels[0];
  for (const section of plan.sections) {
    const depth = section.heading?.depth ?? null;
    const frame: MapFrame = { id: section.id, title: section.title, depth };
    const last = columns.at(-1);
    const opens = depth !== null && level !== undefined && depth <= level;
    if (last && !opens) last.push(frame);
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
 * Rectangles for the groups from the measured content heights, keyed by frame
 * id (decision 174): one column, every frame at x = 0, top to bottom in
 * document order. `FRAME_GAP` separates the frames of a group, `COLUMN_GAP` the
 * last frame of a group from the first of the next. A frame's place depends
 * only on the frames before it in document order.
 */
export function placeFrames(
  columns: readonly (readonly Pick<MapFrame, "id">[])[],
  heights: ReadonlyMap<string, number>,
): MapPlacement {
  const frames: FrameRect[] = [];
  const bounds = { width: 0, height: 0 };
  columns.forEach((column, c) => {
    column.forEach(({ id }, row) => {
      const height = frameHeight(heights.get(id));
      const y = frames.length === 0 ? 0 : bounds.height + (row === 0 ? COLUMN_GAP : FRAME_GAP);
      frames.push({ id, x: 0, y, width: FRAME_WIDTH, height, column: c, row });
      bounds.width = FRAME_WIDTH;
      bounds.height = y + height;
    });
  });
  return { frames, bounds };
}
