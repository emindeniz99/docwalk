import type { Mermaid } from "mermaid";
import { purifySvg } from "./purify";

let loaded: Promise<Mermaid> | null = null;

/** Mermaid is large; load it only when a document has a diagram. */
function loadMermaid(): Promise<Mermaid> {
  loaded ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // Encodes HTML in labels and disables click handlers (decision 26).
      securityLevel: "strict",
      // SVG text labels only, so the SVG sanitizer can forbid foreignObject.
      htmlLabels: false,
      // Keys a diagram's own config can never override.
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "maxTextSize",
        "htmlLabels",
        "suppressErrorRendering",
      ],
      suppressErrorRendering: true,
      theme: "default",
    });
    return mermaid;
  });
  return loaded;
}

/**
 * Remove what could make a diagram fetch from the network or change its own
 * security settings before Mermaid sees it:
 * - `%%{init: …}%%` and `%%{config: …}%%` directives;
 * - YAML front matter (`---` … `---` at the top), which can carry config;
 * - image shapes and `img:` keys, which Mermaid preloads with `img.decode()`
 *   before any markup exists for the sanitizer to see;
 * - CSS `url(…)` in `style`/`classDef` lines.
 */
export function prepareDiagramSource(source: string): string {
  return source
    .replace(/^\s*---\n[\s\S]*?\n---\s*\n/, "")
    .replace(/%%\{[\s\S]*?\}%%/g, "")
    .replace(/\bimg\s*:\s*(["'])[^"']*\1/gi, 'img: ""')
    .replace(/url\(\s*[^)]*\)/gi, "none");
}

let counter = 0;

export interface DiagramResult {
  ok: boolean;
  error?: string;
}

/** Render one diagram source into `host`. Never calls `bindFunctions`: no diagram gets interactive callbacks. */
export async function renderDiagram(host: HTMLElement, source: string): Promise<DiagramResult> {
  const mermaid = await loadMermaid();
  const id = `docwalk-mermaid-${++counter}`;
  try {
    const { svg } = await mermaid.render(id, prepareDiagramSource(source));
    host.replaceChildren(purifySvg(svg));
    host.classList.remove("docwalk-diagram-error");
    // The natural size, from the viewBox, lets fitting work without layout.
    const box = host.querySelector("svg")?.viewBox.baseVal;
    if (box && box.width > 0 && box.height > 0) {
      host.dataset["naturalWidth"] = String(box.width);
      host.dataset["naturalHeight"] = String(box.height);
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const pre = document.createElement("pre");
    pre.textContent = source;
    const note = document.createElement("p");
    note.className = "docwalk-diagnostic";
    note.textContent = `This diagram could not be rendered: ${message.split("\n")[0] ?? "unknown error"}`;
    host.replaceChildren(note, pre);
    host.classList.add("docwalk-diagram-error");
    return { ok: false, error: message };
  } finally {
    // Mermaid leaves a temporary container behind when rendering fails.
    document.getElementById(`d${id}`)?.remove();
  }
}

/** Replace every ```mermaid code block under `root` with a diagram host and render them in order. */
export async function renderDiagrams(root: ParentNode): Promise<DiagramResult[]> {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
  const results: DiagramResult[] = [];
  for (const code of blocks) {
    const pre = code.parentElement as HTMLElement;
    const host = document.createElement("figure");
    host.className = "docwalk-diagram";
    host.tabIndex = 0;
    host.setAttribute("role", "button");
    host.setAttribute("aria-label", "Diagram. Press Enter to open it full screen.");
    host.dataset["source"] = code.textContent ?? "";
    pre.replaceWith(host);
    results.push(await renderDiagram(host, host.dataset["source"]));
  }
  return results;
}
