import { describe, expect, test } from "vitest";
import { diagramHash, documentKey, sketchKey } from "./identity";

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
});
