import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { prepareDiagramSource } from "../deck/mermaid";

type Elements = ReturnType<typeof convertToExcalidrawElements>;
type Files = NonNullable<Awaited<ReturnType<typeof parseMermaidToExcalidraw>>["files"]>;

export interface ConvertedDiagram {
  elements: Elements;
  files: Files;
}

/**
 * A Mermaid diagram as editable Excalidraw elements (decision 54).
 *
 * The source is hostile (rule 5). It goes through the same pre-pass as the
 * slides (no `%%{init}%%`, front matter, image shapes or CSS `url()`), and
 * mermaid-to-excalidraw 3 lays it out with Pele, without Mermaid and without
 * putting any SVG into the live page; labels become canvas text. A diagram
 * type it cannot convert (Gantt, pie, …) arrives as one SVG image, which
 * Excalidraw draws through an `<img>`, where scripts never run. Click links
 * are dropped: a sketch must not carry a document's links to elsewhere.
 */
export async function convertDiagram(source: string): Promise<ConvertedDiagram> {
  const result = await parseMermaidToExcalidraw(prepareDiagramSource(source));
  const skeleton = result.elements.map((element) => ({ ...element, link: null }));
  const elements = convertToExcalidrawElements(skeleton, { regenerateIds: true }).map((element) =>
    element.link === null ? element : { ...element, link: null },
  );
  return { elements, files: result.files ?? {} };
}
