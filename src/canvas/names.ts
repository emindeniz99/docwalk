import { slugify } from "../export/filename";

/**
 * The export file name of a sketch, without its extension (decision 98).
 * The diagram type is the first word of the diagram's source, which anyone
 * can write, so it goes through the same slug as the title: letters and
 * digits stay, a slash, a quote or a dot becomes a dash.
 */
export function sketchFileName(title: string, index: number | null, kind: string): string {
  return `${slugify(title) || "docwalk"}-diagram-${index ?? (slugify(kind) || "diagram")}`;
}
