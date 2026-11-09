import { m } from "../paraglide/messages.js";
import { CLOBBER_PREFIX, fragmentTarget } from "../render/fragments";
import { OVERFLOW_TOLERANCE_PX, tooSmallDiagrams } from "./measure";
import { documentText } from "./documentText";

/**
 * Semantic pagination (decisions 17 to 19). A slide that does not fit is
 * split in this order, never by pixel slicing and never by shrinking:
 *
 * 1. at the next heading level down (H2 slide -> its H3 groups), keeping the
 *    parent title in the breadcrumb; neighbouring groups that fit on one
 *    page together share it;
 * 2. at block boundaries (paragraphs, headings, whole lists, whole tables);
 * 3. inside a list (by item, keeping `<ol start>` numbering) or a table (by
 *    row, repeating the header).
 *
 * Code blocks, diagrams, images, quotes and anything else are atomic: one
 * taller than an empty slide gets a page of its own and keeps its overflow
 * diagnostic. Pages after the first are titled "<title> · continued".
 *
 * The slide's footnote list is not a block: each page shows the footnotes
 * its own blocks cite, and is measured with them (decision 107).
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

    // remark-rehype's list (a <div> since slides.ts), rebuilt for every page tried.
    // It is appended after all content, so it is the last match: a raw HTML
    // section the author marked `data-footnotes` sits above it and stays content.
    const notes =
      [...body.querySelectorAll<HTMLElement>(":scope > [data-footnotes]")].at(-1) ?? null;
    notes?.remove();
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
    // Group 0 keeps the slide heading; a sub-group opens with its own
    // heading and carries the slide title in its breadcrumb.
    const crumbsFor = (g: number) => (g === 0 ? crumbs : [...crumbs, title].filter(Boolean));
    const lay = placer(body, notes);
    const shell = emptyCopy(slide);
    for (const [g, group] of mergeFitting(probe, groups, crumbsFor, lay).entries()) {
      const groupTitle = g === 0 ? title : (group[0]?.textContent ?? "").trim();
      const groupCrumbs = crumbsFor(g);
      setBreadcrumb(probe, groupCrumbs);
      for (const blocks of fillPages(probe, group, groupTitle, lay)) {
        pages.push(makePage(shell, blocks, pages.length, groupCrumbs, notes));
      }
    }
    return pages;
  });
}

/**
 * Join neighbouring sub-heading groups while together they still fit on one
 * page, so three short H3 parts become one slide instead of three
 * half-empty ones. A group that needs several pages on its own never fits
 * with a neighbour, so it stays alone. Merged groups keep the breadcrumb of
 * their first group: group 0 holds the slide heading, so a merge into it
 * needs no parent title.
 */
function mergeFitting(
  probe: HTMLElement,
  groups: Element[][],
  crumbsFor: (g: number) => string[],
  lay: (blocks: Element[]) => void,
): Element[][] {
  const body = bodyOf(probe);
  const merged: Element[][] = [];
  for (const group of groups) {
    const last = merged.at(-1);
    if (last) {
      setBreadcrumb(probe, crumbsFor(merged.length - 1));
      lay([...last, ...group]);
      if (fits(body)) {
        merged[merged.length - 1] = [...last, ...group];
        continue;
      }
    }
    merged.push(group);
  }
  return merged;
}

/**
 * Fill pages greedily with whole blocks, using binary search for the largest
 * prefix that fits, then splitting the next list or table if part of it fits.
 * Pages after the first open with "<title> · continued".
 */
function fillPages(
  probe: HTMLElement,
  blocks: Element[],
  title: string,
  lay: (blocks: Element[]) => void,
): Element[][] {
  const body = bodyOf(probe);
  const pages: Element[][] = [];
  let remaining = [...blocks];

  while (remaining.length > 0) {
    const header = pages.length > 0 && title ? [continuedHeading(title)] : [];
    const tryFit = (candidate: Element[]) => {
      lay([...header, ...candidate]);
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

/**
 * A copy of `slide` with an empty body, for `makePage` to copy once a page:
 * the body's blocks (diagrams among them) would only be copied to be thrown
 * away, once for every page of the slide.
 */
function emptyCopy(slide: HTMLElement): HTMLElement {
  const body = bodyOf(slide);
  const copy = (node: Node): Node => {
    const out = node.cloneNode(false);
    if (node !== body) for (const child of node.childNodes) out.appendChild(copy(child));
    return out;
  };
  return copy(slide) as HTMLElement;
}

function makePage(
  shell: HTMLElement,
  blocks: Element[],
  index: number,
  breadcrumb: string[],
  notes: Element | null,
): HTMLElement {
  const page = shell.cloneNode(true) as HTMLElement;
  page.dataset["page"] = String(index + 1);
  place(bodyOf(page), blocks, notes);
  if (index > 0) tagFootnoteIds(bodyOf(page), index + 1);
  setBreadcrumb(page, breadcrumb);
  return page;
}

/** Lays copies of `blocks` out in `body`, followed by the footnotes they cite. */
function place(body: Element, blocks: Element[], notes: Element | null): void {
  body.replaceChildren(...blocks.map(clone));
  appendFootnotes(body, notes);
}

/**
 * `place` for the probe, which lays out one try after another (decision 43:
 * opening a document waits for them). A try mostly keeps the blocks of the
 * one before and adds or drops a few at the end, so the copies of the blocks
 * both share stay where they are, and a block dropped and taken again gets
 * its copy back. The browser then styles and lays out only what changed,
 * instead of every block of every try. What `body` holds after each call is
 * what `place` would have built; only the footnotes are rebuilt every time.
 */
function placer(body: Element, notes: Element | null): (blocks: Element[]) => void {
  const copies = new Map<Element, Element>();
  let shown: Element[] = [];
  let footnotes: Element | null = null;
  body.replaceChildren();
  return (blocks) => {
    footnotes?.remove();
    let kept = 0;
    while (kept < shown.length && shown[kept] === blocks[kept]) kept++;
    for (const block of shown.slice(kept)) copies.get(block)?.remove();
    for (const block of blocks.slice(kept)) {
      let copy = copies.get(block);
      if (!copy) {
        copy = clone(block);
        copies.set(block, copy);
      }
      body.append(copy);
    }
    shown = blocks;
    footnotes = appendFootnotes(body, notes);
  };
}

/**
 * Appends the footnotes `body` cites (decision 107): the items of the slide's
 * list that a citation in `body` points at, and those cited inside them, in
 * the slide's order with the slide's numbers (`value`), so a 3 in the text
 * reads 3 in the list. An item keeps only the back links to citations in
 * `body`; one to another page would lead nowhere here. Returns the list it
 * appended, if any.
 */
function appendFootnotes(body: Element, notes: Element | null): Element | null {
  const list = notes?.querySelector(":scope > ol");
  if (!notes || !list) return null;
  const cited = new Set<Element>();
  const cite = (root: Element) => {
    for (const ref of root.querySelectorAll("a[data-footnote-ref]")) {
      const item = fragmentTarget(list, ref.getAttribute("href") ?? "");
      if (!item || cited.has(item)) continue;
      cited.add(item);
      cite(item);
    }
  };
  cite(body);
  if (cited.size === 0) return null;
  const items = list.cloneNode(false) as Element;
  for (const [i, item] of [...list.children].entries()) {
    if (!cited.has(item)) continue;
    const shown = clone(item);
    shown.setAttribute("value", String(i + 1));
    items.append(shown);
  }
  const copy = notes.cloneNode(false) as Element;
  // The hidden "Footnotes" label the citations name with aria-describedby.
  copy.append(...[...notes.children].filter((c) => c !== list).map(clone), items);
  body.append(copy);
  for (const back of copy.querySelectorAll("a[data-footnote-backref]")) {
    if (!fragmentTarget(body, back.getAttribute("href") ?? "")) back.remove();
  }
  return copy;
}

/**
 * Page 2 and later can show a footnote that page 1 shows too, and each page
 * with footnotes has its own hidden label. Their ids, the citations' ids and
 * the links between them get
 * the page after the `user-content-` prefix (`#2.ledger-fn-a`), so ids stay
 * unique in the deck (decision 107). A section id never holds a dot, so no
 * other slide's id can match.
 */
function tagFootnoteIds(body: Element, page: number): void {
  const tag = (id: string) =>
    id.startsWith(CLOBBER_PREFIX)
      ? `${CLOBBER_PREFIX}${page}.${id.slice(CLOBBER_PREFIX.length)}`
      : id;
  const named = "a[data-footnote-ref], [data-footnotes] > h2, [data-footnotes] > ol > li";
  for (const el of body.querySelectorAll(named)) if (el.id) el.id = tag(el.id);
  for (const link of body.querySelectorAll("a[data-footnote-ref], a[data-footnote-backref]")) {
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) link.setAttribute("href", `#${page}.${href.slice(1)}`);
    const label = link.getAttribute("aria-describedby");
    if (label) link.setAttribute("aria-describedby", label.split(" ").map(tag).join(" "));
  }
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
    nav.setAttribute("aria-label", m.deck_section_path());
    slide.querySelector(".docwalk-slide")?.prepend(nav);
  }
  nav.replaceChildren(documentText(breadcrumb.join(" › ")));
}

function continuedHeading(title: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "docwalk-part-title";
  const marker = document.createElement("span");
  marker.className = "docwalk-continued";
  marker.textContent = ` · ${m.deck_continued()}`;
  h.append(title, marker);
  return h;
}

function sectionTitle(slide: HTMLElement): string {
  // Only a top-level heading titles the slide: one nested in a footnote list
  // (its hidden "Footnotes" label), a quote or <details> is content.
  const heading = bodyOf(slide).querySelector(":scope > :is(h1, h2, h3, h4, h5, h6)");
  if (!heading) return "";
  // The "· continued" marker is an element, so it is dropped in any language.
  const copy = heading.cloneNode(true) as Element;
  for (const marker of copy.querySelectorAll(".docwalk-continued")) marker.remove();
  return (copy.textContent ?? "").trim();
}

function breadcrumbOf(slide: HTMLElement): string[] {
  const text = slide.querySelector(".docwalk-breadcrumb")?.textContent ?? "";
  return text ? text.split(" › ") : [];
}

function bodyOf(slide: HTMLElement): HTMLElement {
  return (slide.querySelector<HTMLElement>(".docwalk-slide-body") ?? slide) as HTMLElement;
}

/**
 * A page holding a diagram too small to read shows a note under its body,
 * and the note takes its height from the body (rule 3). Show that note in the
 * probe while measuring, so the content it would push out of view moves to
 * the next page instead of overflowing unreported.
 */
function reserveNote(body: HTMLElement): void {
  const note = body.parentElement?.querySelector<HTMLElement>(":scope > .docwalk-overflow");
  if (!note) return;
  const count = tooSmallDiagrams(body);
  note.hidden = count === 0;
  if (count > 0) note.textContent = m.deck_too_small({ count });
}

function fits(body: HTMLElement): boolean {
  reserveNote(body);
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
