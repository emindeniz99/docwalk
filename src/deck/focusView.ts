/** Every open focus view (decision 87) carries this class. Kept apart so the shortcut hooks stay light. */
export const FOCUS_VIEW_CLASS = "docwalk-focus";

/** True when `target` is inside an open focus view: the app's shortcuts leave those keys alone. */
export function inFocusView(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`.${FOCUS_VIEW_CLASS}`) !== null;
}
