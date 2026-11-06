import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { MAX_DOCUMENT_BYTES } from "../inputs/types";
import { WorkspaceError } from "./errors";
import { buildArchive, MAX_ARCHIVE_ENTRIES, MAX_UNPACKED_BYTES, readArchive } from "./zip";

const text = (contents: Awaited<ReturnType<typeof readArchive>>, path: string) =>
  strFromU8(contents.files.find((f) => f.path === path)!.data);

describe("zip import treats the archive as hostile (rule 5)", () => {
  test("documents are kept; unsafe paths, hidden entries and other file types are counted, not written", async () => {
    const archive = zipSync({
      "docs/README.md": strToU8("# Docs\n"),
      "docs/notes.txt": strToU8("plain"),
      "../escape.md": strToU8("# Out\n"),
      "docs/../../escape2.md": strToU8("# Out\n"),
      "docs/logo.png": new Uint8Array([137, 80, 78, 71]),
      "__MACOSX/docs/._README.md": strToU8("resource fork"),
      ".git/config.txt": strToU8("hidden"),
    });
    const contents = await readArchive(archive);
    expect(contents.files.map((f) => f.path).toSorted()).toEqual([
      "docs/README.md",
      "docs/notes.txt",
    ]);
    expect(text(contents, "docs/README.md")).toBe("# Docs\n");
    expect(contents.skipped).toBe(5);
  });

  test("a file above the 2 MB document cap is left out, the rest still import", async () => {
    const archive = zipSync({
      "big.md": new Uint8Array(MAX_DOCUMENT_BYTES + 1).fill(97),
      "small.md": strToU8("# Small\n"),
    });
    const contents = await readArchive(archive);
    expect(contents.files.map((f) => f.path)).toEqual(["small.md"]);
    expect(contents.skipped).toBe(1);
  });

  test("a zip bomb is stopped at the unpacked cap instead of filling memory", async () => {
    // Highly compressible: about 25 MB of the same byte squeezed into a few KB,
    // spread over files that are each under the per-file cap.
    const files: Record<string, Uint8Array> = {};
    const chunk = new Uint8Array(MAX_DOCUMENT_BYTES - 1).fill(48);
    for (let i = 0; i < Math.ceil(MAX_UNPACKED_BYTES / chunk.length) + 2; i++)
      files[`f${i}.md`] = chunk;
    const archive = zipSync(files, { level: 9 });
    expect(archive.length).toBeLessThan(1024 * 1024);
    await expect(readArchive(archive)).rejects.toThrow(/unpacks to more than/);
  });

  test("an archive with too many entries is refused", async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_ARCHIVE_ENTRIES; i++) files[`e${i}.md`] = new Uint8Array(0);
    await expect(readArchive(zipSync(files))).rejects.toThrow(WorkspaceError);
  });

  test("a file that is not a zip is reported as not a zip, not as a zip without Markdown", async () => {
    // fflate's streaming reader emits no entries for bytes without a zip
    // signature and does not throw, so "holds no Markdown files" sent people
    // looking for missing files instead of a broken or renamed download.
    for (const bytes of [
      strToU8("# just markdown, renamed to .zip\n"),
      new Uint8Array(100 * 1024).fill(7),
      new Uint8Array(0),
    ]) {
      const error: unknown = await readArchive(bytes).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as Error).message).toMatch(/not a zip archive/);
    }
  });

  test("an empty but valid zip is not mistaken for a broken file", async () => {
    // The caller tells "no Markdown in it" apart by an empty result.
    const contents = await readArchive(zipSync({}));
    expect(contents.files).toEqual([]);
  });
});

describe("zip export", () => {
  test("round-trips files and keeps empty folders", async () => {
    const blob = await buildArchive(
      [{ path: "project/README.md", data: strToU8("# Project\n") }],
      ["project", "empty"],
    );
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(entries).toSorted()).toEqual(["empty/", "project/", "project/README.md"]);
    const back = await readArchive(new Uint8Array(await blob.arrayBuffer()));
    expect(back.folders.toSorted()).toEqual(["empty", "project"]);
    expect(text(back, "project/README.md")).toBe("# Project\n");
  });
});
