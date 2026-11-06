import { afterEach, describe, expect, test, vi } from "vitest";
import { sourceKey } from "../comments/identity";
import { DB_NAME, openCommentStore } from "../comments/store";
import type { DocComment } from "../comments/types";
import { dropAnnotations, moveAnnotations } from "./annotations";
import type { WorkspaceSource } from "./types";

const at = (path: string): WorkspaceSource => ({ kind: "workspace", root: "opfs", path });

const comment = (id: string): DocComment => ({
  id,
  anchor: { kind: "heading", slug: "intro" },
  text: "A note",
  created: 1,
  updated: 1,
  resolved: false,
});

afterEach(() => vi.restoreAllMocks());

describe("moving comments with workspace renames and deletes", () => {
  // Each rename or delete opened its own connection to the comment database
  // and never closed it, so a long session of file operations piled up open
  // IndexedDB connections for the life of the tab.
  test("renames and deletes share one connection instead of opening one each", async () => {
    const store = await openCommentStore();
    await store.save(sourceKey(at("a.md"))!, [comment("c1")]);
    await store.save(sourceKey(at("c.md"))!, [comment("c2")]);

    const open = vi.spyOn(IDBFactory.prototype, "open");
    await moveAnnotations([[at("a.md"), at("b.md")]]);
    await dropAnnotations([at("c.md")]);
    await moveAnnotations([[at("b.md"), at("d.md")]]);
    expect(open.mock.calls.filter(([name]) => name === DB_NAME).length).toBeLessThanOrEqual(1);

    // And the operations still did their job against the real database.
    expect(await store.load(sourceKey(at("a.md"))!)).toEqual([]);
    expect(await store.load(sourceKey(at("b.md"))!)).toEqual([]);
    expect((await store.load(sourceKey(at("d.md"))!)).map((c) => c.id)).toEqual(["c1"]);
    expect(await store.load(sourceKey(at("c.md"))!)).toEqual([]);
  });
});
