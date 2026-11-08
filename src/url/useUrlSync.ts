import { useEffect, useLayoutEffect, useRef } from "react";
import type { DeckController, SlideInfo } from "../deck/controller";
import type { LevelOption } from "../sectioning/sectionize";
import { formatViewerUrl, parseViewerUrl } from "./state";
import type { ViewerUrlState } from "./types";

export interface UrlSyncOptions {
  /** The deck, once it has rendered; `null` while it is being built. */
  controller: DeckController | null;
  /**
   * Changes when another document is shown (useDocument's `openedId`), never
   * on an edit, a level or language change, or a disk reload of the same file.
   */
  documentId: number;
  level: LevelOption | null;
  view: ViewerUrlState["view"];
  /**
   * The sections presented (decision 100), `null` for all of them. Left out
   * by a page that does not manage the choice, which then never touches
   * `?sections=`.
   */
  sections?: readonly string[] | null | undefined;
  /** Called once on mount when the URL carries a valid `?level=`. */
  onLevel: (level: NonNullable<ViewerUrlState["level"]>) => void;
  /** Called once on mount when the URL carries a valid `?view=`. */
  onView: (view: NonNullable<ViewerUrlState["view"]>) => void;
}

function isSecurityError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "SecurityError";
}

/**
 * Runs `fn` and swallows a SecurityError: a sandboxed iframe without
 * history access must still show the deck, it just cannot sync the URL.
 */
function guarded<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    if (isSecurityError(error)) return undefined;
    throw error;
  }
}

function currentState(): ViewerUrlState | undefined {
  return guarded(() => parseViewerUrl(new URL(window.location.href)));
}

/** The valid `?sections=` the page was opened with, or `null`; the app seeds its state from it. */
export function readInitialSections(): string[] | null {
  return currentState()?.sections ?? null;
}

/** Rewrites the current history entry; a slide change must not add one. */
function replaceUrl(state: Partial<ViewerUrlState>): void {
  guarded(() => {
    const next = formatViewerUrl(new URL(window.location.href), state);
    if (next.href !== window.location.href)
      window.history.replaceState(window.history.state, "", next);
  });
}

/** Goes to an address; a page that no longer exists falls back to the section's first page. False when neither exists. */
function goTo(controller: DeckController, address: string): boolean {
  if (controller.current()?.address === address) return true;
  return controller.goTo(address) || controller.goTo(address.slice(0, address.lastIndexOf("/")));
}

/** The slide the viewer was on in the deck before a rebuild. */
interface Position {
  slides: SlideInfo[];
  index: number;
}

/**
 * Where the slide at `previous` is in `next` when its section id no longer
 * exists, as after typing in its heading: the same distance from the nearest
 * neighbouring section that still exists. Null when that neighbour is gone
 * too, as in another document, which then opens on its first slide.
 */
function relocate({ slides, index }: Position, next: SlideInfo[]): string | null {
  const lost = slides[index]?.sectionId;
  const survives = (i: number) => {
    const id = slides[i]?.sectionId;
    return id !== undefined && id !== lost && next.some((s) => s.sectionId === id);
  };
  let before = index - 1;
  while (before >= 0 && slides[before]?.sectionId === lost) before--;
  if (survives(before)) {
    const id = slides[before]!.sectionId;
    const anchor = next.findLastIndex((s) => s.sectionId === id);
    return next[Math.min(anchor + index - before, next.length - 1)]?.address ?? null;
  }
  let after = index + 1;
  while (after < slides.length && slides[after]?.sectionId === lost) after++;
  if (before < 0 && survives(after)) {
    const id = slides[after]!.sectionId;
    const anchor = next.findIndex((s) => s.sectionId === id);
    return next[Math.max(anchor - (after - index), 0)]?.address ?? null;
  }
  return null;
}

/**
 * Keeps the slide address (hash) and the viewer settings (query) in the URL
 * (decisions 20, 21 and 100), so a link reopens the deck where it was shared.
 */
export function useUrlSync({
  controller,
  documentId,
  level,
  view,
  sections,
  onLevel,
  onView,
}: UrlSyncOptions): void {
  const callbacks = useRef({ onLevel, onView });
  const shownId = useRef(documentId);
  useLayoutEffect(() => {
    callbacks.current = { onLevel, onView };
    shownId.current = documentId;
  });

  useEffect(() => {
    const state = currentState();
    if (state?.level != null) callbacks.current.onLevel(state.level);
    if (state?.view != null) callbacks.current.onView(state.view);
  }, []);

  // On the first render the app still holds its defaults, which must not
  // overwrite the link's values, so only a change is written back.
  const reflected = useRef({ level, view });
  useEffect(() => {
    if (reflected.current.level === level && reflected.current.view === view) return;
    reflected.current = { level, view };
    replaceUrl({ level: typeof level === "object" && level !== null ? [...level] : level, view });
  }, [level, view]);

  // The choice of sections: written only when it changes, and compared by
  // content because the app may hand over a new array with the same ids.
  const sectionsKey = sections === undefined ? undefined : JSON.stringify(sections);
  const reflectedSections = useRef(sectionsKey);
  useEffect(() => {
    if (sectionsKey === reflectedSections.current) return;
    reflectedSections.current = sectionsKey;
    if (sectionsKey !== undefined)
      replaceUrl({ sections: JSON.parse(sectionsKey) as string[] | null });
  }, [sectionsKey]);

  // The slide the viewer is on, kept across rebuilds: the hash cannot hold it
  // under a `#doc=` fragment or without history access.
  const position = useRef<Position | null>(null);
  /** The document of the last deck shown; `null` before the page's first deck. */
  const deckOf = useRef<number | null>(null);
  useEffect(() => {
    if (!controller) return;
    // Another document opens on its first slide: the old address may name a
    // section it shares (Summary, Overview), and opening there would land
    // mid-deck. The page's first document keeps the link's address.
    const id = shownId.current;
    if (deckOf.current !== null && deckOf.current !== id) {
      position.current = null;
      replaceUrl({ address: null });
    }
    deckOf.current = id;
    // A new controller of the same document means a rebuilt deck (an edit, a
    // new level): the hash, or else memory, still names the slide the viewer was on.
    const previous = position.current;
    const initial = currentState()?.address ?? previous?.slides[previous.index]?.address;
    if (initial && !goTo(controller, initial) && previous) {
      const moved = relocate(previous, controller.slides());
      if (moved) goTo(controller, moved);
    }
    const unsubscribe = controller.onChange((slide) => {
      position.current = { slides: controller.slides(), index: slide.index };
      replaceUrl({ address: slide.address });
    });

    const follow = () => {
      const address = currentState()?.address;
      if (address) goTo(controller, address);
    };
    window.addEventListener("hashchange", follow);
    window.addEventListener("popstate", follow);
    return () => {
      unsubscribe();
      window.removeEventListener("hashchange", follow);
      window.removeEventListener("popstate", follow);
    };
  }, [controller]);
}
