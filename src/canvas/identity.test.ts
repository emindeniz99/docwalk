import { describe, expect, test } from "vitest";
import {
  diagramHash,
  documentKey,
  sketchKey,
  sketchKeyBounds,
  sketchKeyDocument,
} from "./identity";

describe("sketch identity (decision 54)", () => {
  test("a document loaded from a link is keyed by that link, so its sketches come back with it", () => {
    expect(documentKey({ kind: "url", url: "https://example.test/a.md", trusted: true })).toBe(
      "url:https://example.test/a.md",
    );
    // Two refs of one file are different documents: a sketch of main must not open on a branch.
    const main = documentKey({ kind: "repo", repo: "o/r", path: "doc.md", ref: "main" });
    const branch = documentKey({ kind: "repo", repo: "o/r", path: "doc.md", ref: "dev" });
    expect(main).not.toBe(branch);
    expect(documentKey({ kind: "file", name: "design.md" })).toBe("file:design.md");
  });

  test("a workspace file is keyed by its root and path", () => {
    // Two files of one workspace are two documents, like two links.
    const a = documentKey({ kind: "workspace", root: "opfs", path: "a.md" });
    expect(a).toBe("workspace:opfs:a.md");
    expect(documentKey({ kind: "workspace", root: "opfs", path: "b.md" })).not.toBe(a);
    // The same path in two picked folders is two documents.
    expect(documentKey({ kind: "workspace", root: "folder", folder: "f1", path: "a.md" })).not.toBe(
      documentKey({ kind: "workspace", root: "folder", folder: "f2", path: "a.md" }),
    );
  });

  test("documents with no address share one key per kind", () => {
    expect(documentKey({ kind: "sample" })).toBe("sample");
    expect(documentKey({ kind: "paste" })).toBe("paste");
    expect(documentKey({ kind: "fragment" })).toBe("fragment");
  });

  test("a diagram is keyed by its content: the same source matches, any edit does not", async () => {
    const a = await diagramHash("flowchart LR\n  a --> b\n");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await diagramHash("flowchart LR\n  a --> b\n")).toBe(a);
    expect(await diagramHash("flowchart LR\n  a --> c\n")).not.toBe(a);
  });

  test("one diagram in two documents gets two sketches", async () => {
    const hash = await diagramHash("flowchart LR\n  a --> b\n");
    expect(sketchKey("file:a.md", hash)).not.toBe(sketchKey("file:b.md", hash));
  });

  test("a document's key bounds hold every one of its sketches and none of a file with a longer name", () => {
    // Renaming or deleting a workspace file moves its sketches by this range;
    // a.md must not take a.md.bak's or a folder a.md/'s sketches with it.
    const [lower, upper] = sketchKeyBounds("workspace:opfs:a.md");
    const within = (key: string) => key >= lower && key <= upper;
    expect(within(sketchKey("workspace:opfs:a.md", "0".repeat(64)))).toBe(true);
    expect(within(sketchKey("workspace:opfs:a.md", "f".repeat(64)))).toBe(true);
    expect(within(sketchKey("workspace:opfs:a.md.bak", "0".repeat(64)))).toBe(false);
    expect(within(sketchKey("workspace:opfs:a.md/x.md", "0".repeat(64)))).toBe(false);
    expect(within(sketchKey("workspace:opfs:a.m", "f".repeat(64)))).toBe(false);
  });

  test("a sketch's key gives back its document, whatever the document's name holds (decision 98)", () => {
    const hash = "ab".repeat(32);
    expect(sketchKeyDocument(sketchKey("file:a.md", hash))).toBe("file:a.md");
    // A file name may hold a line break; the hash never does, so the last one is the divider.
    expect(sketchKeyDocument(sketchKey("file:a\nb.md", hash))).toBe("file:a\nb.md");
  });
});
