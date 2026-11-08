/**
 * The deck's public surface for the rest of the app (outline, command
 * palette, URL sync, presenter window, annotation layer). Everything outside
 * src/deck/ talks to the deck through this interface, never through reveal.js
 * directly, so the shell could change without touching those modules.
 */
import { anchorTarget } from "../render/fragments";
import { slideText } from "./slideText";

export interface SlideInfo {
  /** 0-based position in the deck. */
  index: number;
  /** Stable address, `<section-id>/<page>` (decision 21). */
  address: string;
  sectionId: string;
  /** 1-based page within the section. */
  page: number;
  /** Section title as written in the document. */
  title: string;
  /** True when the slide shows an overflow or too-small diagnostic. */
  flagged: boolean;
  /** The diagnostic text shown on the slide, when flagged. */
  note: string | null;
  /**
   * The words on this page, for search (decision 81). Read from the page the
   * first time it is asked for, then kept until the deck is rebuilt.
   */
  readonly text: string;
}

export interface DeckController {
  slides(): SlideInfo[];
  current(): SlideInfo | null;
  /**
   * Go to a slide by address; a bare section id goes to its first page, and
   * a sub-heading's anchor to the page that holds that heading. Returns
   * false when unknown.
   */
  goTo(address: string): boolean;
  next(): void;
  prev(): void;
  /** Called after every slide change, including the first render. Returns an unsubscribe function. */
  onChange(listener: (slide: SlideInfo) => void): () => void;
  /** The element that holds the visible slides, for overlays such as the pen layer. */
  stage(): HTMLElement;
}

/** A slide's page element, copied so a consumer can change it without touching the live deck. */
export interface ClonedPage {
  info: SlideInfo;
  element: HTMLElement;
}

/**
 * Deep copies of the rendered pages, in deck order, for exporters: they work
 * from the paginated slides the audience sees (decision 9) and mutate what
 * they get. Pages are matched by address, not position, and a slide with no
 * page in the stage throws rather than going missing from an export.
 */
export function clonePages(controller: DeckController): ClonedPage[] {
  const pages = new Map<string, HTMLElement>();
  for (const el of controller
    .stage()
    .querySelectorAll<HTMLElement>(":scope > section[data-docwalk-id]")) {
    pages.set(`${el.dataset["docwalkId"]}/${el.dataset["page"] ?? "1"}`, el);
  }
  return controller.slides().map((info) => {
    const page = pages.get(info.address);
    if (!page) throw new Error(`Slide ${info.address} is not in the deck.`);
    return { info, element: page.cloneNode(true) as HTMLElement };
  });
}

interface RevealLike {
  getIndices(): { h: number };
  slide(h: number): void;
  next(): void;
  prev(): void;
  on(type: string, listener: () => void): void;
  off(type: string, listener: () => void): void;
}

export function createDeckController(
  reveal: RevealLike,
  pages: HTMLElement[],
  stage: HTMLElement,
): DeckController {
  const infos: SlideInfo[] = pages.map((page, index) => {
    const sectionId = page.dataset["docwalkId"] ?? `slide-${index + 1}`;
    const pageNo = Number(page.dataset["page"] ?? 1);
    let text: string | undefined;
    return {
      index,
      address: `${sectionId}/${pageNo}`,
      sectionId,
      page: pageNo,
      title: page.dataset["title"] ?? sectionId,
      flagged: !(page.querySelector<HTMLElement>(".docwalk-overflow")?.hidden ?? true),
      note: (() => {
        const el = page.querySelector<HTMLElement>(".docwalk-overflow");
        return el && !el.hidden ? (el.textContent ?? null) : null;
      })(),
      get text() {
        return (text ??= slideText(page));
      },
    };
  });
  const byAddress = new Map(infos.map((s) => [s.address, s]));
  // A GitHub link to a sub-heading (`#retry-budget`) names no section: find
  // the page that holds the heading (or a raw HTML anchor) with that anchor.
  const byAnchor = (address: string): SlideInfo | undefined => {
    const index = pages.findIndex((p) => anchorTarget(p, address.split("/")[0] ?? "") !== null);
    return infos[index];
  };

  const current = () => infos[reveal.getIndices().h] ?? null;

  return {
    slides: () => infos,
    current,
    goTo(address) {
      const target = byAddress.get(address) ?? byAddress.get(`${address}/1`) ?? byAnchor(address);
      if (!target) return false;
      reveal.slide(target.index);
      return true;
    },
    next: () => reveal.next(),
    prev: () => reveal.prev(),
    onChange(listener) {
      const handler = () => {
        const slide = current();
        if (slide) listener(slide);
      };
      reveal.on("slidechanged", handler);
      handler();
      return () => reveal.off("slidechanged", handler);
    },
    stage: () => stage,
  };
}
