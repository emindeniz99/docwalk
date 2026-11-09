import { markKey } from "./savedMarks";

/**
 * Pen marks belong to what a slide shows, not only to its address. A rebuild
 * (an edit, an agent write, a file reloaded from disk, a language switch)
 * keeps the marks of a slide whose content is the same, and drops them where
 * the text changed, because a circle around a sentence that moved points at
 * the wrong thing.
 *
 * The key is the slide address plus a hash of the slide body's text. Slide
 * chrome that follows the UI language (the "· continued" marker, the hidden
 * "Footnotes" label, the note under the body) and Mermaid's per-render
 * `<style>` blocks are left out, so a language switch or a re-render alone
 * never drops a mark.
 */
export function markKeys(stage: HTMLElement): Map<string, string> {
  const keys = new Map<string, string>();
  for (const [address, fingerprint] of slideFingerprints(stage)) {
    keys.set(address, markKey(address, fingerprint));
  }
  return keys;
}

/** Each page's address and the fingerprint of its text; saved marks keep it (decision 105). */
export function slideFingerprints(stage: HTMLElement): Map<string, string> {
  const prints = new Map<string, string>();
  for (const page of stage.querySelectorAll<HTMLElement>(":scope > section[data-docwalk-id]")) {
    prints.set(
      `${page.dataset["docwalkId"]}/${page.dataset["page"] ?? "1"}`,
      slideFingerprint(page),
    );
  }
  return prints;
}

/** The fingerprint of one page's text, from the page or a copy of it (an export's clone). */
export function slideFingerprint(page: HTMLElement): string {
  return hash(contentText(page));
}

function contentText(page: HTMLElement): string {
  const body = page.querySelector(".docwalk-slide-body");
  if (!body) return "";
  const copy = body.cloneNode(true) as Element;
  for (const chrome of copy.querySelectorAll(
    ".docwalk-continued, [data-footnotes] > .sr-only, style",
  ))
    chrome.remove();
  return copy.textContent ?? "";
}

/** 32-bit FNV-1a: a short, stable fingerprint; not a security boundary. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
