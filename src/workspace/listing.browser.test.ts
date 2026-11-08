import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { documentPathsUnder, sameListing, writeText } from "./fs";
import type { WorkspaceListing } from "./types";

let root: FileSystemDirectoryHandle;

beforeEach(async () => {
  const top = await navigator.storage.getDirectory();
  root = await top.getDirectoryHandle(`listing-test-${crypto.randomUUID()}`, { create: true });
});

afterEach(async () => {
  const top = await navigator.storage.getDirectory();
  await top.removeEntry(root.name, { recursive: true });
});

describe("the document files under an entry (decision 92)", () => {
  test("lists every document at any depth, from the directory itself, and leaves the rest out", async () => {
    await writeText(root, "a/plan.md", "# Plan\n");
    await writeText(root, "a/b/deep.markdown", "# Deep\n");
    await writeText(root, "a/notes.txt", "notes");
    await writeText(root, "a/image.png", "x");
    await writeText(root, "a/.git/hook.md", "# Hidden\n");
    await writeText(root, "a/node_modules/pkg/readme.md", "# Dependency\n");
    await writeText(root, "other.md", "# Elsewhere\n");
    expect((await documentPathsUnder(root, "a")).toSorted()).toEqual([
      "a/b/deep.markdown",
      "a/notes.txt",
      "a/plan.md",
    ]);
  });

  test("a file is its own list, and the root lists everything", async () => {
    await writeText(root, "a/plan.md", "# Plan\n");
    await writeText(root, "top.md", "# Top\n");
    expect(await documentPathsUnder(root, "a/plan.md")).toEqual(["a/plan.md"]);
    expect((await documentPathsUnder(root, "")).toSorted()).toEqual(["a/plan.md", "top.md"]);
  });
});

const listing = (): WorkspaceListing => ({
  truncated: false,
  nodes: [
    {
      path: "a",
      name: "a",
      kind: "directory",
      children: [{ path: "a/x.md", name: "x.md", kind: "file" }],
    },
    { path: "b.md", name: "b.md", kind: "file" },
  ],
});

describe("comparing two listings (decision 91)", () => {
  test("equal listings are the same, so the tree is not drawn again", () => {
    expect(sameListing(listing(), listing())).toBe(true);
  });

  test("a new file, a different kind or a cut-short listing is a change", () => {
    const added = listing();
    added.nodes[0]!.children!.push({ path: "a/y.md", name: "y.md", kind: "file" });
    expect(sameListing(listing(), added)).toBe(false);

    const swapped = listing();
    swapped.nodes[1] = { path: "b.md", name: "b.md", kind: "directory" };
    expect(sameListing(listing(), swapped)).toBe(false);

    expect(sameListing(listing(), { ...listing(), truncated: true })).toBe(false);
  });
});
