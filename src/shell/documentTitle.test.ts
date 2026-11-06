import { describe, expect, test } from "vitest";
import { parseMarkdown, sectionize } from "../sectioning/sectionize";
import { documentTitle } from "./documentTitle";

const titleOf = (markdown: string) => {
  const root = parseMarkdown(markdown);
  return documentTitle(root, sectionize(root));
};

describe("documentTitle", () => {
  // A new document often starts as one line. It makes no slide (a lone
  // heading has no content), and the header used to fall back to "Untitled"
  // although the author had just typed the name.
  test("a document that is only `# Title` is titled Title", () => {
    expect(titleOf("# Title\n")).toBe("Title");
  });

  test("headings with nothing under them still name the document by the first one", () => {
    expect(titleOf("# Plan\n\n## Goals\n")).toBe("Plan");
  });

  test("a README-shaped document is titled by its cover heading", () => {
    expect(titleOf("# Ledger\n\nIntro.\n\n## Goals\n\nKeep entries.\n")).toBe("Ledger");
  });

  test("without a cover, the first slide's title names the document", () => {
    expect(titleOf("## Goals\n\nKeep entries.\n\n## Risks\n\nFew.\n")).toBe("Goals");
  });

  // Text before the first heading is not that heading's: naming the document
  // after a later section would put words in the author's mouth.
  test("a document that opens with text has no title", () => {
    expect(titleOf("Just a paragraph.\n\n## Later\n\nMore.\n")).toBe("");
    expect(titleOf("")).toBe("");
  });
});
