import { domToBlob } from "modern-screenshot";
import { inlineFonts, sameOriginRules } from "./css";
import { downloadBlob } from "./download";
import "./export.css";
import { slideFileName } from "./filename";
import { buildPage, sameOrigin, settled } from "./pages";
import type { ExportOptions } from "./types";

/** A 1x1 transparent GIF: what a refused image renders as. */
const REFUSED_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export interface PngFile {
  name: string;
  blob: Blob;
}

interface PngHooks {
  /** Called before each slide is rendered, with its 1-based number. */
  onSlide?: (current: number, total: number) => void;
  /** Where each finished file goes; defaults to a browser download. */
  save?: (file: PngFile) => void | Promise<void>;
}

/**
 * Only an image from the app's own origin may be fetched while capturing.
 * Anything else, including the empty source of a blocked image (which would
 * resolve to the page itself), renders as a transparent pixel: an export
 * must not do what the viewer has not allowed the page to do.
 */
export async function refuseForeignImages(url: string): Promise<string | false> {
  if (url.trim() === "") return REFUSED_IMAGE;
  try {
    return sameOrigin(new URL(url, document.baseURI)) ? false : REFUSED_IMAGE;
  } catch {
    return REFUSED_IMAGE;
  }
}

/** An SVG `<use>` pointing outside the document would be fetched as text, past the image filter. */
function keepNode(node: Node): boolean {
  if (!(node instanceof SVGUseElement)) return true;
  const href = node.getAttribute("href") ?? node.getAttribute("xlink:href") ?? "";
  return href.startsWith("#");
}

/**
 * One PNG per slide at 2x (decision 9), downloaded one after another as
 * `<index>-<address-slug>.png`. Each slide is mounted off-screen at deck
 * size, so it renders exactly as on the stage, then drawn with
 * modern-screenshot. Fonts are passed in as `data:` URLs from the app's own
 * origin, so the library never reads stylesheets or fetches on its own.
 */
export async function exportPng(options: ExportOptions, hooks: PngHooks = {}): Promise<PngFile[]> {
  const total = options.slides.length;
  const text = options.slides.map((s) => s.element.textContent ?? "").join("\n");
  const fonts = await inlineFonts(sameOriginRules(document), text, Number.POSITIVE_INFINITY);
  const save = hooks.save ?? ((file: PngFile) => downloadSequentially(file));

  const host = document.createElement("div");
  host.className = "docwalk-export-capture";
  host.setAttribute("aria-hidden", "true");
  // Links in the slide stay focusable under aria-hidden; inert keeps Tab out of the hidden copy.
  host.inert = true;
  document.body.append(host);
  const files: PngFile[] = [];
  try {
    for (const [i, slide] of options.slides.entries()) {
      hooks.onSlide?.(i + 1, total);
      const page = buildPage(document, slide, i, options, sameOrigin);
      host.replaceChildren(page);
      await settled(page);
      const blob = await domToBlob(page, {
        type: "image/png",
        scale: 2,
        width: options.size.width,
        height: options.size.height,
        backgroundColor: null,
        font: fonts.css ? { cssText: fonts.css } : false,
        fetchFn: refuseForeignImages,
        filter: keepNode,
        timeout: 10_000,
      });
      const file = { name: slideFileName(i + 1, total, slide.address), blob };
      files.push(file);
      await save(file);
    }
  } finally {
    host.remove();
  }
  return files;
}

/** Browsers drop or block downloads fired in a burst; leave a short gap between files. */
async function downloadSequentially(file: PngFile): Promise<void> {
  downloadBlob(file.blob, file.name);
  await new Promise((resolve) => setTimeout(resolve, 250));
}
