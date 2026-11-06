/**
 * Comments (decision 65) and sketches (decision 64) of a workspace file are
 * keyed by its root and path, so they follow the file through a rename or
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
import { openCommentStore } from "../comments/store";
import type { WorkspaceNode, WorkspaceRoot } from "./types";

/** The node's own path when it is a file, else every file path listed under it. */
export function filePaths(node: WorkspaceNode): string[] {
  if (node.kind === "file") return [node.path];
  return (node.children ?? []).flatMap(filePaths);
}

const keysOf = (root: WorkspaceRoot, path: string) => {
  const source = { kind: "workspace", root, path } as const;
  return { comments: sourceKey(source)!, sketches: documentKey(source) };
};

/** Moves comments and sketches from each old path to its new one. */
export async function moveAnnotations(
  root: WorkspaceRoot,
  moves: readonly (readonly [from: string, to: string])[],
): Promise<void> {
  await rekey(root, moves);
}

/** Deletes the comments and sketches of these paths. */
export async function dropAnnotations(
  root: WorkspaceRoot,
  paths: readonly string[],
): Promise<void> {
  await rekey(
    root,
    paths.map((path) => [path, null] as const),
  );
}

async function rekey(
  root: WorkspaceRoot,
  moves: readonly (readonly [string, string | null])[],
): Promise<void> {
  if (moves.length === 0) return;
  const store = await openCommentStore().catch(() => null);
  for (const [from, to] of moves) {
    const old = keysOf(root, from);
    const next = to === null ? null : keysOf(root, to);
    try {
      if (store) {
        const comments = await store.load(old.comments);
        if (next && comments.length > 0) await store.save(next.comments, comments);
        // An empty list removes the record.
        if (comments.length > 0) await store.save(old.comments, []);
      }
    } catch {
      // Comments stay where they were; the rename or delete itself succeeded.
    }
    await moveSketches(old.sketches, next?.sketches ?? null).catch(() => undefined);
  }
}
