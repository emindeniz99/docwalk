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
  return stripFrontMatter(source)
    .replace(/%%\{[\s\S]*?\}%%/g, "")
    .replace(/\bimg\s*:\s*(["'])[^"']*\1/gi, 'img: ""')
    .replace(/url\(\s*[^)]*\)/gi, "none");
}

/**
 * Mermaid 12 reads front matter with `^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+`
 * (`src/diagram-api/regexes.ts`): whitespace may follow either fence, lines
 * may end in CR, and the fences may be indented. This strip accepts more
 * than that, never less: any `---` start, any closing fence indent. Because
 * a closing fence with another indent can end it earlier than Mermaid would,
 * it repeats until the source no longer starts with `---`, so no second
 * block is left for Mermaid to read.
 */
function stripFrontMatter(source: string): string {
  let rest = source;
  while (/^\s*-{3}/.test(rest)) {
    const block = /^\s*-{3}[^\n\r]*[\n\r][\s\S]*?[\n\r][^\S\n\r]*-{3}[^\S\n\r]*(?:[\n\r]|$)/.exec(
      rest,
    );
    // No closing fence: drop the opening line; what is left fails to parse.
    rest = block ? rest.slice(block[0].length) : rest.replace(/^\s*-{3}[^\n\r]*/, "");
  }
  return rest;
}

let counter = 0;

export interface DiagramResult {
  ok: boolean;
  error?: string;
}

/**
 * Rendered diagrams by prepared source (decision 22, "cached SVGs"), so a
 * rebuild clones an unchanged diagram instead of rendering it again. The
 * Mermaid config is fixed in `loadMermaid`, so the source alone is the key.
 * Each entry holds the sanitized nodes as rendered, before fitting.
 */
const rendered = new Map<string, DocumentFragment>();
/** Enough for several documents' diagrams; the oldest entry goes first. */
const RENDERED_LIMIT = 64;

function cloneChildren(from: Node): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const node of from.childNodes) fragment.append(node.cloneNode(true));
  return fragment;
}

function showSvg(host: HTMLElement, nodes: Node) {
  host.replaceChildren(nodes);
  host.classList.remove("docwalk-diagram-error");
  // The natural size, from the viewBox, lets fitting work without layout.
  const box = host.querySelector("svg")?.viewBox.baseVal;
  if (box && box.width > 0 && box.height > 0) {
    host.dataset["naturalWidth"] = String(box.width);
    host.dataset["naturalHeight"] = String(box.height);
  }
}

/**
 * Render one diagram source into `host`. Never calls `bindFunctions`: no diagram gets interactive callbacks.
 * `reuse: false` skips the cache, for a second copy of a diagram in the same deck: a shared
 * SVG would repeat its element ids, and its arrowhead markers would point at the first copy.
 */
export async function renderDiagram(
  host: HTMLElement,
  source: string,
  { reuse = true }: { reuse?: boolean } = {},
): Promise<DiagramResult> {
  const prepared = prepareDiagramSource(source);
  const hit = reuse ? rendered.get(prepared) : undefined;
  if (hit) {
    // Refresh its place, so the entries in use are the last to go.
    rendered.delete(prepared);
    rendered.set(prepared, hit);
    showSvg(host, hit.cloneNode(true));
    return { ok: true };
  }
  const mermaid = await loadMermaid();
  const id = `docwalk-mermaid-${++counter}`;
  try {
    const { svg } = await mermaid.render(id, prepared);
    showSvg(host, purifySvg(svg));
    rendered.set(prepared, cloneChildren(host));
    if (rendered.size > RENDERED_LIMIT) rendered.delete(rendered.keys().next().value as string);
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

/**
 * Replace every ```mermaid code block under `root` with a diagram host and render them in order.
 * `stop` is checked before each diagram, so a build that a newer one has replaced stops
 * queueing Mermaid renders that would delay the current build.
 */
export async function renderDiagrams(
  root: ParentNode,
  stop: () => boolean = () => false,
): Promise<DiagramResult[]> {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
  const results: DiagramResult[] = [];
  const seen = new Set<string>();
  for (const code of blocks) {
    if (stop()) break;
    const pre = code.parentElement as HTMLElement;
    const host = document.createElement("figure");
    host.className = "docwalk-diagram";
    host.tabIndex = 0;
    // A group, not a button: a button's children are presentational, which
    // hid the diagram's own labels from screen readers, and its name would
    // have to contain all of that visible text (WCAG 2.5.3).
    host.setAttribute("role", "group");
    host.setAttribute("aria-label", "Diagram. Press Enter to open it full screen.");
    const source = code.textContent ?? "";
    host.dataset["source"] = source;
    pre.replaceWith(host);
    const key = prepareDiagramSource(source);
    results.push(await renderDiagram(host, source, { reuse: !seen.has(key) }));
    seen.add(key);
  }
  return results;
}
