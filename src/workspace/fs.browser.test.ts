import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MAX_DOCUMENT_BYTES } from "../inputs/types";
import {
  collectFiles,
  createFile,
  createFolder,
  kindAt,
  lastModified,
  listTree,
  readText,
  remove,
  rename,
  writeText,
  WorkspaceError,
} from "./fs";

/**
 * The file operations on a real origin private file system. A picked local
 * folder is the same `FileSystemDirectoryHandle` interface, so these cover
 * both roots (decisions 57, 58).
 */

let root: FileSystemDirectoryHandle;

beforeEach(async () => {
  const top = await navigator.storage.getDirectory();
  root = await top.getDirectoryHandle(`fs-test-${crypto.randomUUID()}`, { create: true });
});

afterEach(async () => {
  const top = await navigator.storage.getDirectory();
  await top.removeEntry(root.name, { recursive: true });
});

const names = async () => (await listTree(root)).nodes.map((n) => n.name);

describe("creating, reading and writing", () => {
  test("a file written in a nested folder reads back, and its folders are created", async () => {
    await writeText(root, "a/b/plan.md", "# Plan\n");
    expect((await readText(root, "a/b/plan.md")).text).toBe("# Plan\n");
    expect(await kindAt(root, "a/b")).toBe("directory");
  });

  test("create refuses to overwrite: New file must never destroy an existing document", async () => {
    await createFile(root, "plan.md", "# Mine\n");
    await expect(createFile(root, "plan.md", "# Other\n")).rejects.toThrow(/already exists/);
    await expect(createFolder(root, "plan.md")).rejects.toThrow(/already exists/);
    expect((await readText(root, "plan.md")).text).toBe("# Mine\n");
  });

  test("a write moves lastModified forward, which is what the disk watcher compares", async () => {
    const first = await writeText(root, "w.md", "one");
    await new Promise((r) => setTimeout(r, 20));
    const second = await writeText(root, "w.md", "two");
    expect(second).toBeGreaterThan(first);
    expect(await lastModified(root, "w.md")).toBe(second);
    expect(await lastModified(root, "gone.md")).toBeNull();
  });

  test("reading applies the same checks as a dropped file: size cap and strict UTF-8", async () => {
    await writeText(root, "binary.md", new Uint8Array([0xff, 0xfe, 0x00]));
    await expect(readText(root, "binary.md")).rejects.toThrow(/UTF-8/);
    await writeText(root, "huge.md", new Uint8Array(MAX_DOCUMENT_BYTES + 1).fill(97));
    await expect(readText(root, "huge.md")).rejects.toThrow(/larger than/);
  });

  test("a path segment the platform would reject fails with a readable WorkspaceError", async () => {
    await expect(writeText(root, "../escape.md", "x")).rejects.toBeInstanceOf(WorkspaceError);
    await expect(writeText(root, "a:b.md", "x")).rejects.toBeInstanceOf(WorkspaceError);
  });
});

describe("listing", () => {
  test("folders first, then documents by natural order; other files and hidden folders are left out", async () => {
    await writeText(root, "b.md", "");
    await writeText(root, "a10.md", "");
    await writeText(root, "a2.md", "");
    await writeText(root, "image.png", "");
    await writeText(root, "zeta/x.md", "");
    await writeText(root, ".git/HEAD.txt", "");
    await writeText(root, "node_modules/pkg/readme.md", "");
    expect(await names()).toEqual(["zeta", "a2.md", "a10.md", "b.md"]);
    expect((await listTree(root)).nodes[0]!.children!.map((c) => c.path)).toEqual(["zeta/x.md"]);
  });
});

describe("rename and delete", () => {
  test("renaming a folder moves everything inside it", async () => {
    await writeText(root, "old/deep/doc.md", "# Deep\n");
    expect(await rename(root, "old", "new")).toBe("new");
    expect((await readText(root, "new/deep/doc.md")).text).toBe("# Deep\n");
    expect(await kindAt(root, "old")).toBeNull();
  });

  test("rename refuses to replace another entry", async () => {
    await writeText(root, "a.md", "A");
    await writeText(root, "b.md", "B");
    await expect(rename(root, "a.md", "b.md")).rejects.toThrow(/already exists/);
    expect((await readText(root, "b.md")).text).toBe("B");
  });

  test("a case-only rename keeps the contents (case-insensitive disks see one entry)", async () => {
    await writeText(root, "plan.md", "# Plan\n");
    expect(await rename(root, "plan.md", "Plan.md")).toBe("Plan.md");
    expect((await readText(root, "Plan.md")).text).toBe("# Plan\n");
    expect(await names()).toEqual(["Plan.md"]);
  });

  test("delete removes a folder with its contents", async () => {
    await writeText(root, "gone/a.md", "");
    await remove(root, "gone");
    expect(await names()).toEqual([]);
  });

  test("collectFiles returns every listed document with its bytes, for the zip export", async () => {
    await writeText(root, "p/README.md", "# P\n");
    await writeText(root, "p/skip.png", "x");
    const files = await collectFiles(root);
    expect(files.map((f) => [f.path, new TextDecoder().decode(f.data)])).toEqual([
      ["p/README.md", "# P\n"],
    ]);
  });
});
