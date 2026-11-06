/**
 * Comments (decision 65) and sketches (decision 64) of a workspace file are
 * keyed by its root (and folder) and path, so they follow the file through a rename or
 * move and go with it on delete. Without this a renamed file lost both, and
 * a new file created later at a deleted file's path showed the old file's
 * comments and sketches.
 *
 * Both stores are this browser's IndexedDB. A store that cannot be opened
 * (blocked, private mode) has nothing to move, so failures are ignored: the
 * file operation the user asked for has already happened.
 */
import { documentKey } from "../canvas/identity";
import { moveSketches } from "../canvas/store";
import { sourceKey } from "../comments/identity";
import { openCommentStore, type CommentStore } from "../comments/store";
import type { WorkspaceNode, WorkspaceSource } from "./types";

/** The node's own path when it is a file, else every file path listed under it. */
export function filePaths(node: WorkspaceNode): string[] {
  if (node.kind === "file") return [node.path];
  return (node.children ?? []).flatMap(filePaths);
}

const keysOf = (source: WorkspaceSource) => ({
  comments: sourceKey(source)!,
  sketches: documentKey(source),
});

/** Moves comments and sketches from each old file to its new one. */
export async function moveAnnotations(
  moves: readonly (readonly [from: WorkspaceSource, to: WorkspaceSource])[],
): Promise<void> {
  await rekey(moves);
}

/** Deletes the comments and sketches of these files. */
export async function dropAnnotations(files: readonly WorkspaceSource[]): Promise<void> {
  await rekey(files.map((file) => [file, null] as const));
}

/**
 * One connection for every rename and delete in this tab: the store has no
 * close(), so opening one per call left each open for the tab's life. A
 * failed open is not kept, and a failed operation drops the connection (another
 * tab's upgrade may have closed it), so the next call opens a fresh one.
 */
let commentStore: Promise<CommentStore | null> | null = null;
function sharedCommentStore(): Promise<CommentStore | null> {
  commentStore ??= openCommentStore().catch(() => {
    commentStore = null;
    return null;
  });
  return commentStore;
}

async function rekey(
  moves: readonly (readonly [WorkspaceSource, WorkspaceSource | null])[],
): Promise<void> {
  if (moves.length === 0) return;
  const store = await sharedCommentStore();
  for (const [from, to] of moves) {
    const old = keysOf(from);
    const next = to === null ? null : keysOf(to);
    try {
      if (store) {
        const comments = await store.load(old.comments);
        if (next && comments.length > 0) await store.save(next.comments, comments);
        // An empty list removes the record.
        if (comments.length > 0) await store.save(old.comments, []);
      }
    } catch {
      // Comments stay where they were; the rename or delete itself succeeded.
      commentStore = null;
    }
    await moveSketches(old.sketches, next?.sketches ?? null).catch(() => undefined);
  }
}
