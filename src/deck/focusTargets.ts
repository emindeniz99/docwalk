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
type FocusKind = "code" | "table" | "image";

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

/** The id of the section a page address belongs to: the address without its page number. */
function sectionOf(address: string): string {
  return address.slice(0, Math.max(0, address.lastIndexOf("/")));
}

/**
 * The blocks a number counts among: for a table, the page it is on, because
 * a table can split and two screens may cut it differently. A code block,
 * an image or a diagram never splits (rule 3), so the number counts across
 * every page of the section and does not depend on where either screen
 * paginated (decision 106).
 */
function numbered(pages: readonly Element[], kind: FocusViewKind): HTMLElement[] {
  return pages.flatMap((page) => blocksOf(page, kind));
}

function pagesOfSection(stage: ParentNode, id: string): HTMLElement[] {
  return [...stage.querySelectorAll<HTMLElement>(":scope > section[data-docwalk-id]")].filter(
    (page) => page.dataset["docwalkId"] === id,
  );
}

/**
 * Where a block sits: its page's address, its kind and its number among that
 * kind on the page for a table, in the whole section for the others.
 */
export function locateBlock(el: HTMLElement, kind: FocusViewKind): FocusPlace | null {
  const page = el.closest<HTMLElement>("section[data-docwalk-id]");
  if (!page) return null;
  const pages =
    kind === "table" || !page.parentElement
      ? [page]
      : pagesOfSection(page.parentElement, page.dataset["docwalkId"] ?? "");
  const at = numbered(pages, kind).indexOf(el);
  return at < 0 ? null : { slide: slideAddress(page), block: kind, n: at + 1 };
}

/**
 * The block `place` names among the pages of `stage`, if this deck has it.
 * A table is looked up on the page with the presenter's address; any other
 * kind in the section the address names, wherever this deck paginated it.
 */
export function findBlock(stage: ParentNode, place: FocusPlace): HTMLElement | null {
  const pages =
    place.block === "table"
      ? pagesOfSection(stage, sectionOf(place.slide)).filter(
          (page) => slideAddress(page) === place.slide,
        )
      : pagesOfSection(stage, sectionOf(place.slide));
  return numbered(pages, place.block)[place.n - 1] ?? null;
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
function unmarkFocusTarget(el: Element): void {
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
