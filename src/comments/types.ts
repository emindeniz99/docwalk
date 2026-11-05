/**
 * Comments (decision 55). A comment points at something in the document
 * that survives edits and re-pagination: a heading's GitHub anchor, or a
 * node of a Mermaid diagram. Never at a slide index (rule 7) and never at a
 * character offset, which the first edit above it would break.
 *
 * Comments live in this browser (IndexedDB, keyed by document identity),
 * travel inside a share link and export as a `<name>.comments.json`
 * sidecar. The Markdown is never written to (rule 1).
 */

/**
 * What a comment is about.
 * - `heading`: the heading whose GitHub anchor is `slug`.
 * - `node`: node `node` (the id written in the Mermaid source, such as
 *   `api_gw` in `api_gw[API gateway]`) of the `diagram`-th Mermaid block
 *   (0-based) under the heading `heading`; `heading` is `""` for diagrams
 *   that come before the first heading.
 */
export type Anchor =
  | { kind: "heading"; slug: string }
  | { kind: "node"; heading: string; diagram: number; node: string };

export interface DocComment {
  id: string;
  anchor: Anchor;
  /** Plain text, shown as text: never parsed as Markdown or HTML. */
  text: string;
  /** Milliseconds since the epoch. */
  created: number;
  updated: number;
  resolved: boolean;
}

/** Longest comment, in UTF-16 code units: a long review note, not a document. */
export const MAX_COMMENT_CHARS = 4000;
/** Most comments one document keeps; a hostile sidecar cannot fill the disk. */
export const MAX_COMMENTS = 500;
/** Largest sidecar file docwalk reads. 500 comments of 4000 characters fit with room to spare. */
export const MAX_SIDECAR_BYTES = 2 * 1024 * 1024;

export const SIDECAR_FORMAT = "docwalk-comments";
export const SIDECAR_VERSION = 1;

/** The sidecar file and the share-link payload share one shape. */
export interface CommentsFile {
  format: typeof SIDECAR_FORMAT;
  version: typeof SIDECAR_VERSION;
  comments: DocComment[];
}
