import type { FocusPlace, FocusViewKind } from "../annotate/mirrorTypes";
import { m } from "../paraglide/messages.js";
import { FOCUS_VIEW_CLASS } from "./focusView";
import { slideAddress } from "./pages";

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

const BLOCK_SELECTOR: Record<FocusViewKind, string> = {
  diagram: ".docwalk-diagram",
  code: "pre",
  table: "table",
  image: "img",
};

/**
 * Whether `el`, found by the selector of `kind`, is a block of that kind
 * whether or not it has loaded. Nothing inside a diagram or a view counts,
 * and an image in a link belongs to the link.
 */
function isBlock(el: Element, kind: FocusViewKind): boolean {
  if (kind === "diagram") return true;
  if (el.closest(`.docwalk-diagram, .${FOCUS_VIEW_CLASS}`)) return false;
  return kind !== "image" || !el.closest("a");
}

/**
 * The blocks of `kind` on a page in document order, loaded or not, so a
 * follower that blocked an image numbers the ones after it as the presenter
 * does (decision 106).
 */
function blocksOf(page: Element, kind: FocusViewKind): HTMLElement[] {
  return [...page.querySelectorAll<HTMLElement>(BLOCK_SELECTOR[kind])].filter((el) =>
    isBlock(el, kind),
  );
}

/** Where a block sits: its page's address, its kind and its number among that kind on the page. */
export function locateBlock(el: HTMLElement, kind: FocusViewKind): FocusPlace | null {
  const page = el.closest<HTMLElement>("section[data-docwalk-id]");
  if (!page) return null;
  const at = blocksOf(page, kind).indexOf(el);
  return at < 0 ? null : { slide: slideAddress(page), block: kind, n: at + 1 };
}

/** The block `place` names among the pages of `stage`, if this deck has it. */
export function findBlock(stage: ParentNode, place: FocusPlace): HTMLElement | null {
  for (const page of stage.querySelectorAll<HTMLElement>(":scope > section[data-docwalk-id]")) {
    if (slideAddress(page) === place.slide) return blocksOf(page, place.block)[place.n - 1] ?? null;
  }
  return null;
}

function kindOf(el: Element): FocusKind | null {
  if (el instanceof HTMLPreElement) return isBlock(el, "code") ? "code" : null;
  if (el instanceof HTMLTableElement) return isBlock(el, "table") ? "table" : null;
  if (!(el instanceof HTMLImageElement)) return null;
  // A blocked image has no `src` yet, so it is never loaded (decision 33).
  return isBlock(el, "image") && isLoadedImage(el) ? "image" : null;
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
