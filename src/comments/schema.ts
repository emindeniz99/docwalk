/**
 * Validation for every way comments enter the app (decision 46): a sidecar
 * file, a share link and IndexedDB (another tab or an older build may have
 * written it). All three are hostile: a file can be hand-made, a link
 * hand-edited. Anything that does not parse is refused whole with a reason,
 * never half-imported, and unknown fields are dropped.
 */
import * as v from "valibot";
import { m } from "../paraglide/messages.js";
import {
  MAX_COMMENT_CHARS,
  MAX_COMMENTS,
  SIDECAR_FORMAT,
  SIDECAR_VERSION,
  type CommentsFile,
  type DocComment,
} from "./types";

/** No control characters (a slug or node id never has one), bounded length. */
const NAME = /^[^\p{Cc}]*$/u;

const AnchorSchema = v.variant("kind", [
  v.object({
    kind: v.literal("heading"),
    slug: v.pipe(v.string(), v.minLength(1), v.maxLength(512), v.regex(NAME)),
  }),
  v.object({
    kind: v.literal("node"),
    heading: v.pipe(v.string(), v.maxLength(512), v.regex(NAME)),
    diagram: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10_000)),
    node: v.pipe(v.string(), v.minLength(1), v.maxLength(200), v.regex(NAME)),
  }),
]);

const Timestamp = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8.64e15));

/**
 * One comment. A time in the future (a hand-made link, a clock set ahead)
 * reads as now: otherwise that copy would win every merge for good, and an
 * edit (`updated + 1`) could step past the largest valid Date.
 */
export const CommentSchema = v.pipe(
  v.object({
    id: v.pipe(v.string(), v.regex(/^[\w-]{1,64}$/)),
    anchor: AnchorSchema,
    text: v.pipe(
      v.string(),
      v.maxLength(MAX_COMMENT_CHARS),
      v.check((t) => t.trim() !== "", "empty comment"),
    ),
    created: Timestamp,
    updated: Timestamp,
    resolved: v.boolean(),
  }),
  v.transform((c) => {
    const updated = Math.min(c.updated, Date.now());
    return { ...c, created: Math.min(c.created, updated), updated };
  }),
);

export const CommentListSchema = v.pipe(v.array(CommentSchema), v.maxLength(MAX_COMMENTS));

const CommentsFileSchema = v.object({
  format: v.literal(SIDECAR_FORMAT),
  version: v.literal(SIDECAR_VERSION),
  comments: CommentListSchema,
});

export type ParseResult = { ok: true; comments: DocComment[] } | { ok: false; message: string };

// Message functions, read when a file is parsed, so they follow the UI language.
export const NOT_A_COMMENTS_FILE = m.comments_not_a_file;
export const NEWER_VERSION = m.comments_newer_version;
export const TOO_MANY = (): string => m.comments_too_many({ max: MAX_COMMENTS });
export const DAMAGED_FILE = m.comments_damaged_file;

/** One comment per id: two copies of the same comment keep the one edited last. */
export function dedupe(comments: readonly DocComment[]): DocComment[] {
  const byId = new Map<string, DocComment>();
  for (const c of comments) {
    const seen = byId.get(c.id);
    if (!seen || c.updated > seen.updated) byId.set(c.id, c);
  }
  return [...byId.values()];
}

/** Validates an already-parsed value as a comments file, with a reason a user can act on when it is not one. */
export function parseCommentsFile(input: unknown): ParseResult {
  const result = v.safeParse(CommentsFileSchema, input);
  if (result.success) return { ok: true, comments: dedupe(result.output.comments) };
  if (typeof input !== "object" || input === null || !("format" in input)) {
    return { ok: false, message: NOT_A_COMMENTS_FILE() };
  }
  const file = input as Record<string, unknown>;
  if (file["format"] !== SIDECAR_FORMAT) return { ok: false, message: NOT_A_COMMENTS_FILE() };
  if (typeof file["version"] === "number" && file["version"] > SIDECAR_VERSION) {
    return { ok: false, message: NEWER_VERSION() };
  }
  if (Array.isArray(file["comments"]) && file["comments"].length > MAX_COMMENTS) {
    return { ok: false, message: TOO_MANY() };
  }
  return { ok: false, message: DAMAGED_FILE() };
}

/** Parses a sidecar's text (JSON). */
export function parseCommentsText(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: NOT_A_COMMENTS_FILE() };
  }
  return parseCommentsFile(parsed);
}

/** The sidecar text: stable key order and indentation, so two exports of the same comments diff cleanly. */
export function serializeComments(comments: readonly DocComment[]): string {
  const file: CommentsFile = {
    format: SIDECAR_FORMAT,
    version: SIDECAR_VERSION,
    comments: comments.map((c) => ({
      id: c.id,
      anchor:
        c.anchor.kind === "heading"
          ? { kind: "heading", slug: c.anchor.slug }
          : {
              kind: "node",
              heading: c.anchor.heading,
              diagram: c.anchor.diagram,
              node: c.anchor.node,
            },
      text: c.text,
      created: c.created,
      updated: c.updated,
      resolved: c.resolved,
    })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Merges imported comments into the ones already here. A comment both sides
 * have keeps the copy edited last; nothing local is dropped. Returns the
 * merged list and how many comments were new or newer, or `null` when the
 * result would pass the per-document cap.
 */
export function mergeComments(
  local: readonly DocComment[],
  incoming: readonly DocComment[],
): { comments: DocComment[]; changed: number } | null {
  const byId = new Map(local.map((c) => [c.id, c] as const));
  let changed = 0;
  for (const c of incoming) {
    const mine = byId.get(c.id);
    if (!mine || c.updated > mine.updated) {
      byId.set(c.id, c);
      changed++;
    }
  }
  if (byId.size > MAX_COMMENTS) return null;
  return { comments: [...byId.values()], changed };
}
