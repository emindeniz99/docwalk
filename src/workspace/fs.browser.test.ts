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

  test("renaming onto a name that differs only by case refuses when that is another file", async () => {
    // OPFS is case-sensitive, so plan.md and Plan.md are two files. The
    // "case-only rename" path used to copy over Plan.md and lose it.
    await writeText(root, "plan.md", "lower");
    await writeText(root, "Plan.md", "UPPER, the only copy");
    await expect(rename(root, "plan.md", "Plan.md")).rejects.toThrow(/already exists/);
    expect((await readText(root, "Plan.md")).text).toBe("UPPER, the only copy");
    expect((await readText(root, "plan.md")).text).toBe("lower");
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

/**
 * A picked local folder on macOS or Windows is case-insensitive: asking for
 * `Plan.md` finds the stored `plan.md`, creating `Plan.md` opens it, and the
 * listing still says `plan.md`. OPFS is case-sensitive, so this wraps a real
 * OPFS folder in those lookup rules. The file handles stay real.
 */
function caseInsensitive(dir: FileSystemDirectoryHandle): FileSystemDirectoryHandle {
  const stored = async (name: string) => {
    for await (const entry of dir.keys())
      if (entry.toLowerCase() === name.toLowerCase()) return entry;
    return null;
  };
  const wrapped = {
    kind: "directory" as const,
    name: dir.name,
    inner: dir,
    entries: async function* () {
      for await (const [name, handle] of dir.entries()) {
        yield [
          name,
          handle.kind === "directory"
            ? caseInsensitive(handle as FileSystemDirectoryHandle)
            : handle,
        ] as [string, FileSystemHandle];
      }
    },
    keys: () => dir.keys(),
    getFileHandle: async (name: string, options?: { create?: boolean }) =>
      dir.getFileHandle((await stored(name)) ?? name, options),
    getDirectoryHandle: async (name: string, options?: { create?: boolean }) =>
      caseInsensitive(await dir.getDirectoryHandle((await stored(name)) ?? name, options)),
    removeEntry: async (name: string, options?: { recursive?: boolean }) =>
      dir.removeEntry((await stored(name)) ?? name, options),
    isSameEntry: async (other: FileSystemHandle) =>
      dir.isSameEntry((other as { inner?: FileSystemDirectoryHandle }).inner ?? other),
  };
  return wrapped as unknown as FileSystemDirectoryHandle;
}

describe("a case-insensitive local folder", () => {
  let disk: FileSystemDirectoryHandle;
  beforeEach(() => {
    disk = caseInsensitive(root);
  });

  test("a case-only rename keeps the file: the copy must not land on the original and then be deleted", async () => {
    await writeText(disk, "plan.md", "# Plan\n");
    expect(await rename(disk, "plan.md", "Plan.md")).toBe("Plan.md");
    expect((await readText(disk, "Plan.md")).text).toBe("# Plan\n");
    expect(await names()).toEqual(["Plan.md"]);
  });

  test("a case-only rename of a folder keeps everything inside it", async () => {
    await writeText(disk, "docs/a.md", "A");
    await writeText(disk, "docs/deep/b.md", "B");
    expect(await rename(disk, "docs", "Docs")).toBe("Docs");
    expect((await readText(disk, "Docs/a.md")).text).toBe("A");
    expect((await readText(disk, "Docs/deep/b.md")).text).toBe("B");
    expect(await names()).toEqual(["Docs"]);
  });

  test("renaming onto another entry's name in a different case refuses", async () => {
    await writeText(disk, "a.md", "A");
    await writeText(disk, "B.md", "B");
    await expect(rename(disk, "a.md", "b.md")).rejects.toThrow(/already exists/);
    expect((await readText(disk, "B.md")).text).toBe("B");
    expect((await readText(disk, "a.md")).text).toBe("A");
  });

  test("New file refuses a name the disk already holds in another case, instead of overwriting it", async () => {
    await writeText(disk, "readme.md", "# Mine\n");
    await expect(createFile(disk, "Readme.md", "# Starter\n")).rejects.toThrow(/already exists/);
    await expect(createFolder(disk, "README.md")).rejects.toThrow(/already exists/);
    expect((await readText(disk, "readme.md")).text).toBe("# Mine\n");
  });

  test("New folder (and zip import's target folder) refuses an existing folder in another case", async () => {
    await writeText(disk, "Docs/keep.md", "keep");
    await expect(createFolder(disk, "docs")).rejects.toThrow(/already exists/);
    expect((await readText(disk, "Docs/keep.md")).text).toBe("keep");
  });

  test("a taken temporary name is left alone and the rename goes through another one", async () => {
    // The case-only rename copies through `<name>.docwalk-rename`. A file of
    // that name is someone's file: it must survive, and the rename must not
    // fail because of it.
    await writeText(disk, "plan.md", "# Plan\n");
    await writeText(disk, "plan.md.docwalk-rename", "someone's file");
    await writeText(disk, "plan.md.docwalk-rename-2", "and another");
    expect(await rename(disk, "plan.md", "Plan.md")).toBe("Plan.md");
    expect((await readText(disk, "Plan.md")).text).toBe("# Plan\n");
    const other = await (await disk.getFileHandle("plan.md.docwalk-rename")).getFile();
    expect(await other.text()).toBe("someone's file");
    const third = await (await disk.getFileHandle("plan.md.docwalk-rename-2")).getFile();
    expect(await third.text()).toBe("and another");
    // Every entry, not only documents: no temporary copy is left behind.
    const entries: string[] = [];
    for await (const key of root.keys()) entries.push(key);
    expect(entries.toSorted()).toEqual([
      "Plan.md",
      "plan.md.docwalk-rename",
      "plan.md.docwalk-rename-2",
    ]);
  });

  test("a temporary folder name that is taken is never merged into or deleted", async () => {
    await writeText(disk, "docs/a.md", "A");
    await writeText(disk, "docs.docwalk-rename/keep.md", "keep");
    expect(await rename(disk, "docs", "Docs")).toBe("Docs");
    expect((await readText(disk, "Docs/a.md")).text).toBe("A");
    expect((await readText(disk, "docs.docwalk-rename/keep.md")).text).toBe("keep");
  });
});
