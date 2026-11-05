import { sameOriginRules } from "./css";
import { escapeStyleText, rewriteCssUrls } from "./cssText";
import "./export.css";
import { buildPages, pageCss, settled, writeHead } from "./pages";
import type { ExportOptions } from "./types";

const FRAME_MARKER = "data-docwalk-print";

/**
 * What the print view may reference: what the deck itself shows. Blocked
 * images have no `src` left to keep; images the viewer chose to load stay.
 */
const deckResources = (url: URL) => ["http:", "https:", "blob:"].includes(url.protocol);

/**
 * Print the deck, or save it as PDF from the print dialog (decision 9).
 * Builds a hidden same-origin iframe with every slide stacked, one slide per
 * 1280x720 page, the app's CSS and fonts copied in, waits for fonts and
 * images, prints, and removes the frame when the browser reports
 * `afterprint`. A frame left over from a browser that never reports it is
 * removed by the next call.
 *
 * `print` exists for tests (a real dialog would block them).
 */
export async function printDeck(
  options: ExportOptions,
  print: (win: Window) => void = (win) => win.print(),
): Promise<void> {
  for (const stale of document.querySelectorAll(`iframe[${FRAME_MARKER}]`)) stale.remove();

  const frame = document.createElement("iframe");
  frame.setAttribute(FRAME_MARKER, "");
  frame.className = "docwalk-print-frame";
  frame.title = "Print view";
  frame.tabIndex = -1;
  frame.setAttribute("aria-hidden", "true");
  // It can outlive the dialog (no afterprint); its links must not take focus meanwhile.
  frame.inert = true;
  // Without a source the frame holds about:blank, which is in quirks mode
  // (tables lose the slide's line height), so pages would not match the
  // measured stage. A doctype in srcdoc gives a standards-mode document that
  // shares the app's origin; filling it waits for that document to load.
  frame.srcdoc = "<!doctype html><title></title>";
  const loaded = new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  document.body.append(frame);
  await loaded;

  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  if (!win || !doc) {
    frame.remove();
    throw new Error("This browser does not allow printing from here.");
  }

  try {
    const css = sameOriginRules(document)
      .map((r) => rewriteCssUrls(r.cssText, r.base, (url) => url.origin === location.origin))
      .join("\n");
    writeHead(doc, options.title, escapeStyleText(`${css}\n${pageCss(options.size)}`));
    const main = buildPages(doc, options, deckResources);
    doc.body.replaceChildren(main);
    await settled(main);
  } catch (error) {
    frame.remove();
    throw error;
  }

  win.addEventListener("afterprint", () => frame.remove(), { once: true });
  print(win);
}
