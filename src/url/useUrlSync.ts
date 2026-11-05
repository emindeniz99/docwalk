import { useEffect, useLayoutEffect, useRef } from "react";
import type { DeckController } from "../deck/controller";
import type { LevelOption } from "../sectioning/sectionize";
import { formatViewerUrl, parseViewerUrl } from "./state";
import type { ViewerUrlState } from "./types";

export interface UrlSyncOptions {
  /** The deck, once it has rendered; `null` while it is being built. */
  controller: DeckController | null;
  level: LevelOption | null;
  view: ViewerUrlState["view"];
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

/** Rewrites the current history entry; a slide change must not add one. */
function replaceUrl(state: Partial<ViewerUrlState>): void {
  guarded(() => {
    const next = formatViewerUrl(new URL(window.location.href), state);
    if (next.href !== window.location.href)
      window.history.replaceState(window.history.state, "", next);
  });
}

/** Goes to an address; a page that no longer exists falls back to the section's first page. */
function goTo(controller: DeckController, address: string): void {
  if (controller.current()?.address === address) return;
  if (!controller.goTo(address)) controller.goTo(address.slice(0, address.lastIndexOf("/")));
}

/**
 * Keeps the slide address (hash) and the viewer settings (query) in the URL
 * (decisions 20 and 21), so a link reopens the deck where it was shared.
 */
export function useUrlSync({ controller, level, view, onLevel, onView }: UrlSyncOptions): void {
  const callbacks = useRef({ onLevel, onView });
  useLayoutEffect(() => {
    callbacks.current = { onLevel, onView };
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

  useEffect(() => {
    if (!controller) return;
    // A new controller means a rebuilt deck (first render, an edit, a new
    // level): the hash still names the slide the viewer was on.
    const initial = currentState()?.address;
    if (initial) goTo(controller, initial);
    const unsubscribe = controller.onChange((slide) => replaceUrl({ address: slide.address }));

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
