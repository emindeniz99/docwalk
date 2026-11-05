/** Opens the presenter window (`?view=presenter`); `null` when a popup blocker refuses. */
export type OpenPresenterWindow = () => Window | null;

/**
 * Opens (or refocuses) the presenter window on the current URL with
 * `?view=presenter`. Kept apart from ./bridge.ts, which must stay free of
 * DOM globals for its Node tests.
 */
export const openPresenterWindow: OpenPresenterWindow = () => {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "presenter");
  // A fixed target name reuses one presenter window instead of stacking new ones.
  return window.open(url.href, "docwalk-presenter", "popup,width=1280,height=800");
};
