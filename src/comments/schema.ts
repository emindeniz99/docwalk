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
  FUTURE_SKEW_MS,
  MAX_AUTHOR_CHARS,
  MAX_COMMENT_CHARS,
  MAX_COMMENTS,
  MAX_TOMBSTONES,
  SIDECAR_FORMAT,
  SIDECAR_VERSION,
  type CommentSet,
  type CommentsFile,
  type DocComment,
  type Tombstone,
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
    // A hash of the diagram's source, in hex (decision 96). Short, so it cannot carry anything else.
    sig: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{1,16}$/))),
  }),
]);

const Timestamp = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(8.64e15));

const Id = v.pipe(v.string(), v.regex(/^[\w-]{1,64}$/));

/** A display name (decision 97): plain text, no control characters, 1 to 40 characters. */
const AuthorSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(MAX_AUTHOR_CHARS),
  v.regex(NAME),
);

/** The name as it would be stored on a comment, or `null` when it is empty or not a valid name. */
export function cleanAuthor(raw: string): string | null {
  const result = v.safeParse(AuthorSchema, raw);
  return result.success ? result.output : null;
}

/** The latest time a stored time may have and still be believed. */
const trustedLimit = () => Date.now() + FUTURE_SKEW_MS;

/**
 * One comment. A time more than the skew allowance ahead of the clock (a
 * hand-made link, a clock set far ahead) is not trusted (decision 95):
 * `updated` falls back to `created` when that is believable, else to 0. A
 * copy that read as "edited just now" would win every merge, and again on
 * every later re-import; a believed time never changes between parses.
 */
export const CommentSchema = v.pipe(
  v.object({
    id: Id,
    anchor: AnchorSchema,
    text: v.pipe(
      v.string(),
      v.maxLength(MAX_COMMENT_CHARS),
      v.check((t) => t.trim() !== "", "empty comment"),
    ),
    author: v.optional(AuthorSchema),
    created: Timestamp,
    updated: Timestamp,
    resolved: v.boolean(),
  }),
  v.transform((c) => {
    const limit = trustedLimit();
    const updated = c.updated > limit ? (c.created > limit ? 0 : c.created) : c.updated;
    return { ...c, created: c.created > limit ? updated : Math.min(c.created, updated), updated };
  }),
);

const CommentListSchema = v.pipe(v.array(CommentSchema), v.maxLength(MAX_COMMENTS));

/** A tombstone carries an id and a time and nothing else; a time too far ahead becomes 0. */
export const TombstoneSchema = v.pipe(
  v.object({ id: Id, deleted: Timestamp }),
  v.transform((t): Tombstone => ({
    id: t.id,
    deleted: t.deleted > trustedLimit() ? 0 : t.deleted,
  })),
);

const TombstoneListSchema = v.pipe(v.array(TombstoneSchema), v.maxLength(MAX_TOMBSTONES));

const CommentsFileSchema = v.object({
  format: v.literal(SIDECAR_FORMAT),
  version: v.literal(SIDECAR_VERSION),
  comments: CommentListSchema,
  deleted: v.optional(TombstoneListSchema, []),
});

export type ParseResult =
  | { ok: true; comments: DocComment[]; deleted: Tombstone[] }
  | { ok: false; message: string };

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

/** One tombstone per id, the later time kept, newest first, at most `MAX_TOMBSTONES`. */
export function dedupeTombstones(deleted: readonly Tombstone[]): Tombstone[] {
  const byId = new Map<string, number>();
  for (const t of deleted) {
    const seen = byId.get(t.id);
    if (seen === undefined || t.deleted > seen) byId.set(t.id, t.deleted);
  }
  return [...byId]
    .map(([id, time]) => ({ id, deleted: time }))
    .toSorted((a, b) => b.deleted - a.deleted)
    .slice(0, MAX_TOMBSTONES);
}

/**
 * The tombstone for a comment that is being deleted. Its time comes after the
 * comment's last edit, or the deletion would lose a tie against the comment.
 */
export function tombstoneFor(comment: DocComment, now: number): Tombstone {
  return { id: comment.id, deleted: Math.max(now, comment.updated + 1) };
}

/** Validates an already-parsed value as a comments file, with a reason a user can act on when it is not one. */
function parseCommentsFile(input: unknown): ParseResult {
  const result = v.safeParse(CommentsFileSchema, input);
  if (result.success) {
    return {
      ok: true,
      comments: dedupe(result.output.comments),
      deleted: dedupeTombstones(result.output.deleted),
    };
  }
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

/**
 * The file shape for a list of comments and deletions, in stable key order.
 * Without deletions it has exactly the keys a build without tombstones wrote.
 */
export function commentsFile(
  comments: readonly DocComment[],
  deleted: readonly Tombstone[] = [],
): CommentsFile {
  return {
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
              ...(c.anchor.sig === undefined ? {} : { sig: c.anchor.sig }),
            },
      text: c.text,
      ...(c.author === undefined ? {} : { author: c.author }),
      created: c.created,
      updated: c.updated,
      resolved: c.resolved,
    })),
    ...(deleted.length === 0
      ? {}
      : { deleted: deleted.map((t) => ({ id: t.id, deleted: t.deleted })) }),
  };
}

/** The sidecar text: stable key order and indentation, so two exports of the same comments diff cleanly. */
export function serializeComments(
  comments: readonly DocComment[],
  deleted: readonly Tombstone[] = [],
): string {
  return `${JSON.stringify(commentsFile(comments, deleted), null, 2)}\n`;
}

interface MergeResult extends CommentSet {
  /** Comments that are new, newer or gone because of a tombstone: what the merge changed. */
  changed: number;
  /** How many of the changes were local comments removed by a tombstone. */
  removed: number;
  /** True when the result differs from `local` in comments or tombstones, so it needs saving. */
  dirty: boolean;
}

function sameTombstones(a: readonly Tombstone[], b: readonly Tombstone[]): boolean {
  if (a.length !== b.length) return false;
  const times = new Map(a.map((t) => [t.id, t.deleted] as const));
  return b.every((t) => times.get(t.id) === t.deleted);
}

/**
 * Merges incoming comments and deletions into what is already here
 * (decisions 65 and 95). A comment both sides have keeps the copy edited
 * last. A deletion beats a copy whose `updated` is not after it; a comment
 * edited after the deletion wins and its tombstone is dropped. Tombstones
 * merge by id and keep the later time, newest first, at most
 * `MAX_TOMBSTONES`. Returns `null` when the comments would pass the
 * per-document cap.
 */
export function mergeSets(local: CommentSet, incoming: CommentSet): MergeResult | null {
  const times = new Map<string, number>();
  for (const t of [...local.deleted, ...incoming.deleted]) {
    const seen = times.get(t.id);
    if (seen === undefined || t.deleted > seen) times.set(t.id, t.deleted);
  }
  const mine = new Map(local.comments.map((c) => [c.id, c] as const));
  const byId = new Map(mine);
  for (const c of incoming.comments) {
    const have = byId.get(c.id);
    if (!have || c.updated > have.updated) byId.set(c.id, c);
  }
  for (const [id, c] of byId) {
    const gone = times.get(id);
    if (gone === undefined) continue;
    if (c.updated > gone) times.delete(id);
    else byId.delete(id);
  }
  if (byId.size > MAX_COMMENTS) return null;

  let changed = 0;
  for (const c of byId.values()) {
    const had = mine.get(c.id);
    if (!had || c.updated > had.updated) changed++;
  }
  let removed = 0;
  for (const id of mine.keys()) if (!byId.has(id)) removed++;
  changed += removed;

  const deleted = dedupeTombstones([...times].map(([id, time]) => ({ id, deleted: time })));
  return {
    comments: [...byId.values()],
    deleted,
    changed,
    removed,
    dirty: changed > 0 || !sameTombstones(local.deleted, deleted),
  };
}

/**
 * A merge of a share link or a sidecar file that removes no comment already
 * here (decision 119). The tombstones that would remove one are held back and
 * returned, so the user can apply them on purpose (`deleteHeld`). Everything
 * else merges as `mergeSets` does.
 */
export function mergeKeepingLocal(
  local: CommentSet,
  incoming: CommentSet,
): { merged: MergeResult | null; held: Tombstone[] } {
  const full = mergeSets(local, incoming);
  if (!full || full.removed === 0) return { merged: full, held: [] };
  const kept = new Set(full.comments.map((c) => c.id));
  const gone = new Set(local.comments.filter((c) => !kept.has(c.id)).map((c) => c.id));
  const held = incoming.deleted.filter((t) => gone.has(t.id));
  const deleted = incoming.deleted.filter((t) => !gone.has(t.id));
  return { merged: mergeSets(local, { comments: incoming.comments, deleted }), held };
}
