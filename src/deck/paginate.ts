import { OVERFLOW_TOLERANCE_PX } from "./measure";

/**
 * Semantic pagination (decisions 17 to 19). A slide that does not fit is
 * split in this order, never by pixel slicing and never by shrinking:
 *
 * 1. at the next heading level down (H2 slide -> its H3 groups), keeping the
 *    parent title in the breadcrumb;
 * 2. at block boundaries (paragraphs, headings, whole lists, whole tables);
 * 3. inside a list (by item, keeping `<ol start>` numbering) or a table (by
 *    row, repeating the header).
 *
 * Code blocks, diagrams, images, quotes and anything else are atomic: one
 * taller than an empty slide gets a page of its own and keeps its overflow
 * diagnostic. Pages after the first are titled "<title> · continued".
 *
 * Works on rendered slides inside an off-screen box with the slide's size,
 * so the result is the same for slides reveal.js is hiding.
 */

export interface PaginateOptions {
  size: { width: number; height: number };
}

const SPLITTABLE_LIST = new Set(["UL", "OL"]);

/** Returns the pages for `slide`; `[slide]` itself when it already fits. */
export function paginateSlide(slide: HTMLElement, options: PaginateOptions): HTMLElement[] {
  return withBox(options.size, (box) => {
    const probe = slide.cloneNode(true) as HTMLElement;
    box.replaceChildren(probe);
    const body = bodyOf(probe);
    if (fits(body)) return [slide];

    const title = sectionTitle(slide);
    const crumbs = breadcrumbOf(slide);
    const pages: HTMLElement[] = [];
    const groups = splitAtSubheadings(body);
    // A slide heading with no text of its own before its first sub-heading
    // would become a title-only page; it joins the first sub-group instead.
    const first = groups[0];
    const second = groups[1];
    if (first && second && first.every((b) => /^H[1-6]$/.test(b.tagName))) {
      groups.splice(0, 2, [...first, ...second]);
    }
    for (const [g, group] of groups.entries()) {
      // Group 0 keeps the slide heading; a sub-group opens with its own
      // heading and carries the slide title in its breadcrumb.
      const groupTitle = g === 0 ? title : (group[0]?.textContent ?? "").trim();
      const groupCrumbs = g === 0 ? crumbs : [...crumbs, title].filter(Boolean);
      setBreadcrumb(probe, groupCrumbs);
      for (const blocks of fillPages(probe, group, groupTitle)) {
        pages.push(makePage(slide, blocks, pages.length, groupCrumbs));
      }
    }
    return pages;
  });
}

/**
 * Fill pages greedily with whole blocks, using binary search for the largest
 * prefix that fits, then splitting the next list or table if part of it fits.
 * Pages after the first open with "<title> · continued".
 */
function fillPages(probe: HTMLElement, blocks: Element[], title: string): Element[][] {
  const body = bodyOf(probe);
  const pages: Element[][] = [];
  let remaining = [...blocks];

  while (remaining.length > 0) {
    const header = pages.length > 0 && title ? [continuedHeading(title)] : [];
    const tryFit = (candidate: Element[]) => {
      body.replaceChildren(...header.map(clone), ...candidate.map(clone));
      return fits(body);
    };

    const k = largestPrefix(remaining.length, (n) => tryFit(remaining.slice(0, n)));
    let page = remaining.slice(0, k);
    remaining = remaining.slice(k);

    const next = remaining[0];
    if (next) {
      // A page holding nothing but headings must take something more, or it
      // would be a bare title: at least the first item or row of a list or
      // table, else the whole (atomic) block. Too tall even then, it keeps
      // its overflow diagnostic.
      const headingsOnly = page.every(isHeading);
      const split = splitBlock(next, (part) => tryFit([...page, part]), headingsOnly);
      if (split) {
        page = [...page, split.head];
        remaining = [split.tail, ...remaining.slice(1)];
      } else if (headingsOnly) {
        page = [...page, next];
        remaining = remaining.slice(1);
      }
    }
    pages.push([...header, ...page]);
  }
  return pages;
}

/**
 * Split a list by item or a table by row so that `head` fits; `null` when not
 * splittable or nothing fits. With `atLeastOne`, `head` holds at least the
 * first item or row even when that alone does not fit.
 */
function splitBlock(
  block: Element,
  fitsWith: (part: Element) => boolean,
  atLeastOne: boolean,
): { head: Element; tail: Element } | null {
  if (SPLITTABLE_LIST.has(block.tagName)) {
    const items = [...block.children].filter((c) => c.tagName === "LI");
    if (items.length < 2) return null;
    const fitting = largestPrefix(items.length - 1, (n) =>
      fitsWith(listWith(block, items.slice(0, n), 0)),
    );
    const k = atLeastOne ? Math.max(fitting, 1) : fitting;
    if (k === 0) return null;
    const start = block.tagName === "OL" ? Number(block.getAttribute("start") ?? 1) : 0;
    return {
      head: listWith(block, items.slice(0, k), 0),
      tail: listWith(block, items.slice(k), block.tagName === "OL" ? start + k : 0),
    };
  }
  const table = block.tagName === "TABLE" ? block : null;
  if (table) {
    const thead = table.querySelector("thead");
    const rows = [...table.querySelectorAll("tbody > tr")];
    if (rows.length < 2) return null;
    const fitting = largestPrefix(rows.length - 1, (n) =>
      fitsWith(tableWith(table, thead, rows.slice(0, n))),
    );
    const k = atLeastOne ? Math.max(fitting, 1) : fitting;
    if (k === 0) return null;
    return {
      head: tableWith(table, thead, rows.slice(0, k)),
      tail: tableWith(table, thead, rows.slice(k)),
    };
  }
  return null;
}

function isHeading(block: Element): boolean {
  return /^H[1-6]$/.test(block.tagName);
}

function largestPrefix(max: number, ok: (n: number) => boolean): number {
  let lo = 0;
  let hi = max;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function listWith(list: Element, items: Element[], start: number): Element {
  const copy = list.cloneNode(false) as Element;
  if (start > 1) copy.setAttribute("start", String(start));
  copy.append(...items.map(clone));
  return copy;
}

function tableWith(table: Element, thead: Element | null, rows: Element[]): Element {
  const copy = table.cloneNode(false) as Element;
  if (thead) copy.append(clone(thead));
  const tbody = document.createElement("tbody");
  tbody.append(...rows.map(clone));
  copy.append(tbody);
  return copy;
}

/**
 * Step 1: split the body at the first heading level below the slide's own
 * heading (H3 under an H2 slide). Content before the first sub-heading stays
 * with the slide heading. Returns one group when there are no sub-headings.
 */
function splitAtSubheadings(body: HTMLElement): Element[][] {
  const blocks = [...body.children];
  const own = blocks.find((b) => /^H[1-6]$/.test(b.tagName));
  const ownLevel = own ? Number(own.tagName[1]) : 0;
  const sub = blocks
    .filter((b) => b !== own && /^H[1-6]$/.test(b.tagName))
    .map((b) => Number(b.tagName[1]))
    .filter((level) => level > ownLevel);
  if (sub.length === 0) return [blocks];
  const splitLevel = Math.min(...sub);
  const groups: Element[][] = [[]];
  for (const b of blocks) {
    if (b.tagName === `H${splitLevel}` && (groups.at(-1)?.length ?? 0) > 0) groups.push([]);
    groups.at(-1)?.push(b);
  }
  return groups.filter((g) => g.length > 0);
}

function makePage(
  original: HTMLElement,
  blocks: Element[],
  index: number,
  breadcrumb: string[],
): HTMLElement {
  const page = original.cloneNode(true) as HTMLElement;
  page.dataset["page"] = String(index + 1);
  bodyOf(page).replaceChildren(...blocks.map(clone));
  setBreadcrumb(page, breadcrumb);
  return page;
}

/** Breadcrumb text is set with textContent only: heading text never becomes markup. */
function setBreadcrumb(slide: HTMLElement, breadcrumb: string[]): void {
  let nav = slide.querySelector<HTMLElement>(".docwalk-breadcrumb");
  if (breadcrumb.length === 0) {
    nav?.remove();
    return;
  }
  if (!nav) {
    nav = document.createElement("nav");
    nav.className = "docwalk-breadcrumb";
    nav.setAttribute("aria-label", "Section path");
    slide.querySelector(".docwalk-slide")?.prepend(nav);
  }
  nav.textContent = breadcrumb.join(" › ");
}

function continuedHeading(title: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "docwalk-part-title";
  const marker = document.createElement("span");
  marker.className = "docwalk-continued";
  marker.textContent = " · continued";
  h.append(title, marker);
  return h;
}

function sectionTitle(slide: HTMLElement): string {
  // Only a top-level heading titles the slide: one nested in a footnote list
  // (its hidden "Footnotes" label), a quote or <details> is content.
  const heading = bodyOf(slide).querySelector(":scope > :is(h1, h2, h3, h4, h5, h6)");
  return (heading?.textContent ?? "").replace(/\s*· continued$/, "").trim();
}

function breadcrumbOf(slide: HTMLElement): string[] {
  const text = slide.querySelector(".docwalk-breadcrumb")?.textContent ?? "";
  return text ? text.split(" › ") : [];
}

function bodyOf(slide: HTMLElement): HTMLElement {
  return (slide.querySelector<HTMLElement>(".docwalk-slide-body") ?? slide) as HTMLElement;
}

function fits(body: HTMLElement): boolean {
  return (
    body.scrollHeight - body.clientHeight <= OVERFLOW_TOLERANCE_PX &&
    body.scrollWidth - body.clientWidth <= OVERFLOW_TOLERANCE_PX
  );
}

function clone<T extends Node>(node: T): T {
  return node.cloneNode(true) as T;
}

function withBox<T>(size: { width: number; height: number }, run: (box: HTMLElement) => T): T {
  const box = document.createElement("div");
  box.className = "docwalk-measure";
  Object.assign(box.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    width: `${size.width}px`,
    height: `${size.height}px`,
    contain: "strict",
  });
  document.body.append(box);
  try {
    return run(box);
  } finally {
    box.remove();
  }
}
