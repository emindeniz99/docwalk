import { m } from "../paraglide/messages.js";
import { FOCUS_VIEW_CLASS } from "./focusView";

/**
 * The blocks of a slide that open in the focus view next to diagrams
 * (decision 87): code blocks, tables and images that have loaded.
 *
 * The marks are added to the finished, sanitized DOM, after pagination, by
 * code and never from the document, so no author markup can make an
 * element a target or forge a name. A mark is `data-docwalk-focus` plus a
 * tab stop and a name that says how to open the block; exports remove them.
 */
export type FocusKind = "code" | "table" | "image";

export const FOCUS_ATTR = "data-docwalk-focus";
/** Set when the block already had a name of its own, so removing the mark leaves it. */
const OWN_LABEL_ATTR = "data-docwalk-own-label";
/** The kind a slide element was marked with, or null when it is not a focus target. */
export function focusKind(el: Element): FocusKind | null {
  const kind = el.getAttribute(FOCUS_ATTR);
  return kind === "code" || kind === "table" || kind === "image" ? kind : null;
}

/** An image the viewer can see: complete, with a size. A broken or pending one has nothing to show. */
export function isLoadedImage(img: HTMLImageElement): boolean {
  return img.complete && img.naturalWidth > 0;
}

function hasOwnName(el: Element): boolean {
  return (
    el.hasAttribute("aria-label") ||
    el.hasAttribute("aria-labelledby") ||
    el.querySelector(":scope > caption") !== null
  );
}

function kindOf(el: Element): FocusKind | null {
  if (el.closest(`.docwalk-diagram, .${FOCUS_VIEW_CLASS}`)) return null;
  if (el instanceof HTMLPreElement) return "code";
  if (el instanceof HTMLTableElement) return "table";
  if (!(el instanceof HTMLImageElement)) return null;
  // A blocked image has no \`src\` yet, so it is never loaded (decision 33); an image in a link
  // belongs to the link.
  return isLoadedImage(el) && !el.closest("a") ? "image" : null;
}

/** Marks one element when it qualifies, and does nothing otherwise. */
export function markFocusTarget(el: Element): void {
  const kind = kindOf(el);
  if (!kind || el.hasAttribute(FOCUS_ATTR)) return;
  el.setAttribute(FOCUS_ATTR, kind);
  el.setAttribute("tabindex", "0");
  const own = hasOwnName(el);
  if (own) el.setAttribute(OWN_LABEL_ATTR, "");
  if (kind === "code") el.setAttribute("role", "group");
  if (kind === "image") el.setAttribute("role", "button");
  if (own) return;
  if (kind === "code") el.setAttribute("aria-label", m.code_label());
  else if (kind === "table") el.setAttribute("aria-label", m.table_label());
  else {
    const alt = el.getAttribute("alt");
    el.setAttribute("aria-label", alt ? m.image_label_alt({ alt }) : m.image_label());
  }
}

/** Marks every code block, table and loaded image under `root`. */
export function markFocusTargets(root: ParentNode): void {
  for (const el of root.querySelectorAll("pre, table, img")) markFocusTarget(el);
}

/** Takes the mark off one element, leaving a name the author gave it. */
export function unmarkFocusTarget(el: Element): void {
  const kind = focusKind(el);
  if (!kind) return;
  el.removeAttribute(FOCUS_ATTR);
  el.removeAttribute("tabindex");
  if (kind !== "table") el.removeAttribute("role");
  if (!el.hasAttribute(OWN_LABEL_ATTR)) el.removeAttribute("aria-label");
  el.removeAttribute(OWN_LABEL_ATTR);
}

/** Takes every mark off `root` and its descendants. */
export function unmarkFocusTargets(root: Element): void {
  for (const el of [root, ...root.querySelectorAll(`[${FOCUS_ATTR}]`)]) unmarkFocusTarget(el);
}
