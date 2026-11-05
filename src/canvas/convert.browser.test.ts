import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { visit } from "unist-util-visit";
import { describe, expect, test } from "vitest";
import fixture from "../../fixtures/ledger-redesign.md?raw";
import { parseMarkdown } from "../sectioning/sectionize";
import { convertDiagram } from "./convert";

/** The fixture's Mermaid blocks, in order, read from the Markdown AST rather than a regex. */
async function fixtureDiagrams(): Promise<string[]> {
  const sources: string[] = [];
  visit(parseMarkdown(fixture), (node) => {
    if (node.type === "code" && node.lang === "mermaid") sources.push(node.value);
  });
  return sources;
}

const texts = (elements: readonly { type: string }[]) =>
  elements.filter((e): e is { type: "text"; text: string } => e.type === "text").map((e) => e.text);

/** Span of the boxes; skeleton arrows and labels may carry no width of their own. */
function width(all: readonly { type: string; x?: number; width?: number }[]): number {
  const boxes = all.filter((e) => e.type === "rectangle");
  return (
    Math.max(...boxes.map((e) => (e.x ?? 0) + (e.width ?? 0))) -
    Math.min(...boxes.map((e) => e.x ?? 0))
  );
}

describe("Mermaid to Excalidraw (decision 54)", () => {
  test("every diagram in the acceptance fixture converts into an editable sketch", async () => {
    // The fixture is the doc docwalk is measured against: a sketch must open for each of its diagrams.
    const sources = await fixtureDiagrams();
    expect(sources).toHaveLength(7);
    const results: { elements: number; kind: string; files: number }[] = [];
    for (const source of sources) {
      const { elements, files } = await convertDiagram(source);
      const image = elements.some((e) => e.type === "image");
      results.push({
        elements: elements.length,
        kind: image ? "image" : "shapes",
        files: Object.keys(files).length,
      });
    }
    expect(results.every((r) => r.elements > 0)).toBe(true);
    // Flowcharts, the state, sequence and ER diagrams become shapes; Gantt has no
    // Excalidraw form and arrives as one picture of itself, carried as one file.
    expect(results.map((r) => `${r.kind}:${r.files}`)).toEqual([
      "shapes:0",
      "shapes:0",
      "shapes:0",
      "shapes:0",
      "shapes:0",
      "image:1",
      "shapes:0",
    ]);
  });

  test("node labels become canvas text a viewer can edit", async () => {
    const [first] = await fixtureDiagrams();
    const { elements } = await convertDiagram(first ?? "");
    expect(texts(elements)).toEqual(
      expect.arrayContaining(["Client apps", "API gateway", "Payments API"]),
    );
  });

  test("click links in a hostile diagram never reach the sketch", async () => {
    // A link on a shape is a way off the page the document's author chose, not the viewer.
    const source = [
      "flowchart LR",
      "  a[Start] --> b[Next]",
      '  click a "https://phish.example/login" "Log in"',
      '  click b href "javascript:alert(1)"',
    ].join("\n");
    // Precondition: the converter itself does carry the link through, so dropping it is ours.
    const raw = await parseMermaidToExcalidraw(source);
    expect(raw.elements.some((e) => "link" in e && e.link)).toBe(true);
    const { elements } = await convertDiagram(source);
    expect(elements.length).toBeGreaterThan(0);
    expect(elements.filter((e) => e.link !== null)).toEqual([]);
  });

  test("the security pre-pass runs first: an init directive cannot change the layout", async () => {
    // Directives are how a diagram reconfigures its renderer (decision 26 strips them).
    const plain = "flowchart LR\n  a[A] --> b[B]\n";
    const directed = `%%{init: {'flowchart': {'nodeSpacing': 400, 'rankSpacing': 400}}}%%\n${plain}`;
    // Precondition: the converter on its own obeys the directive.
    const raw = await parseMermaidToExcalidraw(directed);
    const rawPlain = await parseMermaidToExcalidraw(plain);
    expect(width(raw.elements as never)).toBeGreaterThan(width(rawPlain.elements as never) + 100);
    const clean = await convertDiagram(plain);
    const stripped = await convertDiagram(directed);
    expect(width(stripped.elements)).toBe(width(clean.elements));
  });

  test("a diagram that does not parse rejects, so the dialog can say so", async () => {
    await expect(convertDiagram("flowchart LR\n  a --> \n  end end end")).rejects.toBeInstanceOf(
      Error,
    );
  });
});
